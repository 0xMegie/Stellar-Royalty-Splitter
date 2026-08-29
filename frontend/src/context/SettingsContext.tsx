import React, { createContext, useContext, useState, useEffect } from "react";
import i18n from "../i18n";

export interface SettingsType {
  autoSaveAuditLog: boolean;
  notifyOnDistribution: boolean;
  displayCurrency: "XLM" | "USD" | "EUR";
  maxPayoutsPerTransaction: number;
  minPayoutAmount: number;
  trackedContracts: string[];
  language: "en" | "es" | "de" | "zh";
}

interface SettingsContextType {
  settings: SettingsType;
  updateSettings: (patch: Partial<SettingsType>) => void;
  addTrackedContract: (contractId: string) => boolean;
  removeTrackedContract: (contractId: string) => void;
}

const DEFAULTS: SettingsType = {
  autoSaveAuditLog: true,
  notifyOnDistribution: true,
  displayCurrency: "XLM",
  maxPayoutsPerTransaction: 10,
  minPayoutAmount: 0.1,
  trackedContracts: [],
  language: "en",
};

// A contract ID on Stellar starts with "C" and is 56 characters long.
export function isValidContractId(id: string): boolean {
  return id.startsWith("C") && id.length === 56;
}

export function normalizeContractList(contracts: string[]): string[] {
  return Array.from(new Set(contracts.map((c) => c.trim()).filter(isValidContractId)));
}

const SettingsContext = createContext<SettingsContextType | undefined>(
  undefined,
);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [settings, setSettings] = useState<SettingsType>(() => {
    try {
      const raw = localStorage.getItem("royaltySplitterSettings");
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (_) {}
    return DEFAULTS;
  });

  useEffect(() => {
    // Persist settings whenever they change
    try {
      localStorage.setItem("royaltySplitterSettings", JSON.stringify(settings));
    } catch (_) {}
  }, [settings]);

  useEffect(() => {
    // Sync i18n language with settings language preference
    if (settings.language && i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language);
    }
  }, [settings.language]);

  const updateSettings = (patch: Partial<SettingsType>) =>
    setSettings((s) => ({ ...s, ...patch }));

  const addTrackedContract = (contractId: string): boolean => {
    const trimmed = contractId.trim();
    if (!isValidContractId(trimmed)) return false;
    if (settings.trackedContracts.includes(trimmed)) return false;
    setSettings((s) =>
      s.trackedContracts.includes(trimmed)
        ? s
        : { ...s, trackedContracts: [...s.trackedContracts, trimmed] },
    );
    return true;
  };

  const removeTrackedContract = (contractId: string) =>
    setSettings((s) => ({
      ...s,
      trackedContracts: s.trackedContracts.filter((c) => c !== contractId),
    }));

  return (
    <SettingsContext.Provider
      value={{ settings, updateSettings, addTrackedContract, removeTrackedContract }}
    >
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
};

export default SettingsProvider;
