import { useState } from "react";
import { useTheme } from "../context/ThemeContext";
import {
  useSettings,
  SettingsType,
  isValidContractId,
} from "../context/SettingsContext";

import { CopyButton } from "./CopyButton";
import { PaymentPreferences } from "./PaymentPreferences";
import { NotificationPreferences } from "./NotificationPreferences";
import "./Settings.css";

interface SettingsProps {
  contractId: string;
  walletAddress?: string | null;
  onClearContract?: () => void;
}

export const Settings: React.FC<SettingsProps> = ({
  contractId,
  walletAddress,
  onClearContract,
}) => {
  const { isDark, toggleTheme } = useTheme();
  const { settings, updateSettings, addTrackedContract, removeTrackedContract } =
    useSettings();
  const [localSettings, setLocalSettings] = useState(() => ({ ...settings }));

  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [newContractId, setNewContractId] = useState("");
  const [contractError, setContractError] = useState<string | null>(null);

  const handleToggle = (key: keyof typeof localSettings) => {
    const newValue = !localSettings[key];
    setLocalSettings({ ...localSettings, [key]: newValue });
    showSaveStatus("Saving...");
  };

  const handleChange = (key: keyof typeof localSettings, value: string | number) => {
    setLocalSettings({ ...localSettings, [key]: value });
  };

  const handleDarkMode = () => {
    toggleTheme();
    showSaveStatus("✓ Theme updated!");
  };

  const handleSave = () => {
    // Persist via SettingsContext (saves to localStorage)
    updateSettings(localSettings);
    showSaveStatus("✓ Settings saved successfully!");
  };

  const handleReset = () => {
    if (window.confirm("Reset all settings to defaults?")) {
      const defaults: SettingsType = {
        autoSaveAuditLog: true,
        notifyOnDistribution: true,
        displayCurrency: "XLM",
        maxPayoutsPerTransaction: 10,
        minPayoutAmount: 0.1,
        trackedContracts: [],
      };
      setLocalSettings(defaults);
      updateSettings(defaults);
      showSaveStatus("✓ Settings reset to defaults!");
    }
  };

  const handleAddContract = () => {
    const trimmed = newContractId.trim();
    if (!isValidContractId(trimmed)) {
      setContractError("Contract ID must start with C and be 56 characters");
      return;
    }
    if (!addTrackedContract(trimmed)) {
      setContractError("This contract is already being tracked");
      return;
    }
    setLocalSettings((s) => ({
      ...s,
      trackedContracts: Array.from(new Set([...s.trackedContracts, trimmed])),
    }));
    setNewContractId("");
    setContractError(null);
    showSaveStatus("✓ Contract added to tracked list!");
  };

  const handleRemoveContract = (id: string) => {
    removeTrackedContract(id);
    setLocalSettings((s) => ({
      ...s,
      trackedContracts: s.trackedContracts.filter((c) => c !== id),
    }));
    showSaveStatus("✓ Contract removed from tracked list!");
  };

  const showSaveStatus = (message: string) => {
    setSaveStatus(message);
    setTimeout(() => setSaveStatus(null), 3000);
  };

  return (
    <div className="settings">
      <div className="settings-header">
        <h1>⚙️ Settings</h1>
        <p className="settings-subtitle settings-contract-id">
          <span>Contract ID: {contractId || "Not connected"}</span>
          {contractId && (
            <CopyButton value={contractId} label="contract ID" size="sm" />
          )}
        </p>
      </div>

      {saveStatus && <div className="save-status">{saveStatus}</div>}

      <div className="settings-content">
        {/* General Settings */}
        <section className="settings-section">
          <h2 className="section-title">General</h2>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="currency">Display Currency</label>
              <p className="setting-description">
                Choose your preferred currency for displaying amounts
              </p>
            </div>
            <select
              id="currency"
              value={localSettings.displayCurrency}
              onChange={(e) => handleChange("displayCurrency", e.target.value)}
              className="setting-select"
            >
              <option value="XLM">Stellar Lumens (XLM)</option>
              <option value="USD">US Dollars (USD)</option>
              <option value="EUR">Euros (EUR)</option>
            </select>
          </div>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="darkMode">Dark Mode</label>
              <p className="setting-description">
                Enable dark theme for the dashboard
              </p>
            </div>
            <button
              className={`toggle-btn ${isDark ? "active" : ""}`}
              onClick={handleDarkMode}
              id="darkMode"
            >
              {isDark ? "ON" : "OFF"}
            </button>
          </div>
        </section>

        {/* Tracked Contracts */}
        <section className="settings-section">
          <h2 className="section-title">Tracked Contracts</h2>
          <p className="setting-description">
            Add contract IDs to compare and aggregate earnings across multiple
            projects on the earnings dashboard.
          </p>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="newContractId">Add Contract ID</label>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", width: "100%" }}>
              <input
                id="newContractId"
                type="text"
                placeholder="C..."
                value={newContractId}
                onChange={(e) => {
                  setNewContractId(e.target.value);
                  setContractError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddContract();
                }}
                className="setting-input"
              />
              <button
                type="button"
                className="btn-primary"
                onClick={handleAddContract}
              >
                Add
              </button>
            </div>
          </div>
          {contractError && (
            <p role="alert" className="contract-input-error">
              {contractError}
            </p>
          )}

          {settings.trackedContracts.length === 0 ? (
            <p className="setting-description">
              No contracts tracked yet. Add one above to enable the
              multi-contract earnings comparison view.
            </p>
          ) : (
            <ul className="tracked-contracts-list" aria-label="Tracked contracts">
              {settings.trackedContracts.map((id) => (
                <li key={id} className="tracked-contract-item">
                  <span title={id}>{id}</span>
                  {id === contractId && (
                    <span className="you-badge">Active</span>
                  )}
                  <CopyButton value={id} label="contract ID" size="sm" />
                  <button
                    type="button"
                    aria-label={`Remove contract ${id}`}
                    onClick={() => handleRemoveContract(id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Distribution Settings */}
        <section className="settings-section">
          <h2 className="section-title">Distribution</h2>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="maxPayouts">Max Payouts Per Transaction</label>
              <p className="setting-description">
                Maximum number of collaborators to pay in a single transaction
              </p>
            </div>
            <input
              id="maxPayouts"
              type="number"
              min="1"
              max="100"
              value={localSettings.maxPayoutsPerTransaction}
              onChange={(e) =>
                handleChange(
                  "maxPayoutsPerTransaction",
                  parseInt(e.target.value),
                )
              }
              className="setting-input"
            />
          </div>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="minPayout">Minimum Payout Amount (XLM)</label>
              <p className="setting-description">
                Minimum amount required for a payout transaction
              </p>
            </div>
            <input
              id="minPayout"
              type="number"
              min="0.1"
              step="0.1"
              value={localSettings.minPayoutAmount}
              onChange={(e) =>
                handleChange("minPayoutAmount", parseFloat(e.target.value))
              }
              className="setting-input"
            />
          </div>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="autoSave">Auto-Save Audit Log</label>
              <p className="setting-description">
                Automatically save transaction audit logs
              </p>
            </div>
            <button
              className={`toggle-btn ${
                localSettings.autoSaveAuditLog ? "active" : ""
              }`}
              onClick={() => handleToggle("autoSaveAuditLog")}
              id="autoSave"
            >
              {localSettings.autoSaveAuditLog ? "ON" : "OFF"}
            </button>
          </div>
        </section>

        {/* Notification Settings */}
        <section className="settings-section">
          <h2 className="section-title">Notifications</h2>

            <div className="setting-item">
              <div className="setting-label">
                <label htmlFor="notifyDist">Notify on Distribution</label>
                <p className="setting-description">
                  Send notification when distributions are processed
                </p>
              </div>
              <button
                className={`toggle-btn ${
                  localSettings.notifyOnDistribution ? "active" : ""
                }`}
                onClick={() => handleToggle("notifyOnDistribution")}
                id="notifyDist"
              >
                {localSettings.notifyOnDistribution ? "ON" : "OFF"}
              </button>
            </div>
        </section>

        {/* Payment Preferences */}
        <PaymentPreferences walletAddress={walletAddress ?? ""} />

        {/* Notification Preferences (#605) */}
        <NotificationPreferences walletAddress={walletAddress ?? ""} />

        {/* About Section */}
        <section className="settings-section">
          <h2 className="section-title">About</h2>
          <div className="about-content">
            <div className="about-item">
              <h3>Stellar Royalty Splitter</h3>
              <p>Version 1.0.0</p>
              <p className="about-description">
                A decentralized platform for managing royalty distributions
                using the Stellar blockchain.
              </p>
            </div>
            <div className="about-item">
              <h3>Smart Contract</h3>
              <p>Soroban Runtime</p>
              <p className="about-description">
                Built on Stellar Testnet for secure, transparent transactions.
              </p>
            </div>
            <div className="about-item">
              <h3>Support</h3>
              <p>
                <a
                  href="https://stellar.org"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Stellar Docs
                </a>
              </p>
              <p>
                <a
                  href="https://github.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub Repository
                </a>
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Action Buttons */}
      <div className="settings-actions">
        <button className="btn-primary" onClick={handleSave}>
          💾 Save Settings
        </button>
        <button className="btn-secondary" onClick={handleReset}>
          🔄 Reset to Defaults
        </button>
        {onClearContract && (
          <button className="btn-secondary" onClick={onClearContract}>
            🗑️ Clear Saved Contract
          </button>
        )}
      </div>
    </div>
  );
};
