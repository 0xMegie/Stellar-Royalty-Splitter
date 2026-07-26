import { Router } from "express";
import { z } from "zod";
import logger from "../logger.js";
import { validate } from "../validation.js";
import { sendError } from "../error-response.js";
import {
  isAdminRotateTokenValid,
  reloadSigningKeyFromSecretsFile,
  rotateSigningKey,
} from "../signing-key.js";
import { requireAdminBearerOrRole, createUser } from "../middleware/rbac.js";

export const adminRouter = Router();

const rotateKeySchema = z
  .object({
    secretKey: z
      .string()
      .regex(/^S[A-Z2-7]{55}$/, "Invalid Stellar secret key")
      .optional(),
    reloadFromFile: z.boolean().optional(),
  })
  .refine((body) => Boolean(body.secretKey) || body.reloadFromFile === true, {
    message: "Provide secretKey or set reloadFromFile to true",
  });

/**
 * Legacy bearer-token guard kept for backward compatibility.
 * New deployments should prefer RBAC API keys (requireAdminBearerOrRole).
 */
function requireAdminRotateToken(req, res, next) {
  if (!process.env.ADMIN_ROTATE_TOKEN) {
    logger.warn("Admin rotate-key rejected: ADMIN_ROTATE_TOKEN not configured", {
      event: "signing_key_rotate_denied",
      reason: "token_not_configured",
    });
    return sendError(res, 503, "service_unavailable", "Key rotation is not configured on this server");
  }

  const header = req.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!isAdminRotateTokenValid(token)) {
    logger.warn("Admin rotate-key rejected: invalid token", {
      event: "signing_key_rotate_denied",
      reason: "invalid_token",
    });
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }

  next();
}

/**
 * POST /admin/rotate-key
 * Body: { secretKey?: string, reloadFromFile?: boolean }
 * Header: Authorization: Bearer <ADMIN_ROTATE_TOKEN>
 */
adminRouter.post(
  "/rotate-key",
  requireAdminRotateToken,
  validate(rotateKeySchema),
  (req, res, next) => {
    try {
      const result = req.body.reloadFromFile
        ? reloadSigningKeyFromSecretsFile()
        : rotateSigningKey(req.body.secretKey, { source: "api" });

      res.json({
        publicKey: result.publicKey,
        rotatedAt: result.rotatedAt,
        source: result.source,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /admin/users
 * Create a user with a role. Requires admin privilege (bearer token or RBAC).
 * Body: { walletAddress, role }
 * Returns: { userId }
 */
const createUserSchema = z.object({
  walletAddress: z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address"),
  role: z.enum(["viewer", "collaborator", "operator", "admin"]),
});

adminRouter.post(
  "/users",
  requireAdminBearerOrRole("admin"),
  validate(createUserSchema),
  (req, res, next) => {
    try {
      const userId = createUser(req.body.walletAddress, req.body.role);
      logger.info("Admin: created user", { userId, role: req.body.role });
      res.status(201).json({ userId });
    } catch (err) {
      next(err);
    }
  },
);
