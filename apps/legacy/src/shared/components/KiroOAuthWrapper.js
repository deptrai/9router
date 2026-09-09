"use client";

import { useState, useCallback } from "react";
import PropTypes from "prop-types";
import OAuthModal from "./OAuthModal";
import KiroAuthModal from "./KiroAuthModal";
import KiroSocialOAuthModal from "./KiroSocialOAuthModal";
import KiroEnterpriseSSOModal from "./KiroEnterpriseSSOModal";

/**
 * Kiro OAuth Wrapper
 * Orchestrates between method selection, device code flow, and social login flow
 */
export default function KiroOAuthWrapper({ isOpen, providerInfo, onSuccess, onClose }) {
  const [authMethod, setAuthMethod] = useState(null); // null | "builder-id" | "idc" | "social" | "import" | "enterprise-sso"
  const [socialProvider, setSocialProvider] = useState(null); // "google" | "github"
  const [idcConfig, setIdcConfig] = useState(null);

  const handleMethodSelect = useCallback((method, config) => {
    if (method === "builder-id") {
      setAuthMethod("builder-id");
    } else if (method === "idc") {
      setAuthMethod("idc");
      setIdcConfig(config);
    } else if (method === "social") {
      setAuthMethod("social");
      setSocialProvider(config.provider);
    } else if (method === "enterprise-sso") {
      setAuthMethod("enterprise-sso");
    } else if (method === "import") {
      onSuccess?.();
    }
  }, [onSuccess]);

  const handleBack = () => {
    setAuthMethod(null);
    setSocialProvider(null);
    setIdcConfig(null);
  };

  const handleSocialSuccess = () => {
    setAuthMethod(null);
    setSocialProvider(null);
    onSuccess?.();
    onClose?.(); // Close modal after success
  };

  const handleDeviceSuccess = () => {
    setAuthMethod(null);
    setIdcConfig(null);
    onSuccess?.();
    onClose?.(); // Close modal after success
  };

  // Show method selection first
  if (!authMethod) {
    return (
      <KiroAuthModal
        isOpen={isOpen}
        onMethodSelect={handleMethodSelect}
        onClose={onClose}
      />
    );
  }

  // Show device code flow (Builder ID or IDC)
  if (authMethod === "builder-id" || authMethod === "idc") {
    return (
      <OAuthModal
        isOpen={isOpen}
        provider="kiro"
        providerInfo={providerInfo}
        onSuccess={handleDeviceSuccess}
        onClose={handleBack}
        idcConfig={idcConfig}
      />
    );
  }

  // Show social login flow (Google/GitHub with manual callback)
  if (authMethod === "social" && socialProvider) {
    return (
      <KiroSocialOAuthModal
        isOpen={isOpen}
        provider={socialProvider}
        onSuccess={handleSocialSuccess}
        onClose={handleBack}
      />
    );
  }

  // Show enterprise SSO flow (Microsoft 365 two-phase manual callback)
  if (authMethod === "enterprise-sso") {
    return (
      <KiroEnterpriseSSOModal
        isOpen={isOpen}
        onSuccess={onSuccess}
        onClose={handleBack}
      />
    );
  }

  return null;
}

KiroOAuthWrapper.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerInfo: PropTypes.shape({
    name: PropTypes.string,
  }),
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
