"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * Kiro Enterprise SSO Modal (Microsoft 365)
 * Two-phase manual callback flow with two entry modes:
 *
 * Mode "portal" (default):
 *   1. Open Kiro portal sign-in URL
 *   2. Sign in → portal redirects to localhost:3128 with IdP descriptor
 *   3. Paste the callback URL → server discovers OIDC → returns Azure AD auth URL
 *
 * Mode "direct":
 *   1. Enter email, issuer URL, client ID, scopes directly
 *   2. Server discovers OIDC and returns Azure AD auth URL
 *
 * Both modes converge:
 *   4. Open Azure AD auth URL, sign in → redirects to localhost:3128 with auth code
 *   5. Paste the callback URL → server exchanges code for tokens
 */
export default function KiroEnterpriseSSOModal({ isOpen, onSuccess, onClose }) {
  const [step, setStep] = useState("mode_select"); // mode_select | portal | direct | azure_ad | saving | completed | error
  const [sessionId, setSessionId] = useState(null);
  const [signInUrl, setSignInUrl] = useState("");
  const [portalCallback, setPortalCallback] = useState("");
  const [azureCallback, setAzureCallback] = useState("");
  const [azureAuthUrl, setAzureAuthUrl] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const portalTabRef = useRef(null);

  // Direct mode fields
  const [directEmail, setDirectEmail] = useState("del.ferry@cheaprouter.uk");
  const [directIssuerUrl, setDirectIssuerUrl] = useState("https://login.microsoftonline.com/5fbc183e-3d09-4043-b36f-0c49d3665977/v2.0");
  const [directClientId, setDirectClientId] = useState("35dc7c45-a4bc-4fd9-8ea3-5eaf1a733589");
  const [directScopes, setDirectScopes] = useState(
    "openid api://35dc7c45-a4bc-4fd9-8ea3-5eaf1a733589/codewhisperer:conversations api://35dc7c45-a4bc-4fd9-8ea3-5eaf1a733589/codewhisperer:completions offline_access"
  );

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep("mode_select");
      setError(null);
      setSessionId(null);
      setSignInUrl("");
      setPortalCallback("");
      setAzureCallback("");
      setAzureAuthUrl("");
      setSaving(false);
      setSubmitting(false);
      portalTabRef.current = null;
    }
  }, [isOpen]);

  // ── Portal mode ──────────────────────────────────────────────────

  const handleStartPortal = async () => {
    try {
      setError(null);
      setStep("loading");

      const res = await fetch("/api/oauth/kiro/enterprise-sso/start", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setSessionId(data.sessionId);
      setSignInUrl(data.signInUrl);
      setStep("portal");
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  };

  const handleOpenPortal = () => {
    const tab = window.open(signInUrl, "_blank");
    portalTabRef.current = tab;
    if (!tab) {
      setError("Popup blocked. Please allow popups, or copy the URL above and open it manually.");
    }
  };

  const handleResolvePortalCallback = async () => {
    if (submitting) return;
    try {
      setSubmitting(true);
      setError(null);

      const res = await fetch("/api/oauth/kiro/enterprise-sso/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          callbackUrl: portalCallback.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.phase === "azure_ad") {
        setAzureAuthUrl(data.authUrl);
        setStep("azure_ad");
        const tab = window.open(data.authUrl, "_blank");
        if (!tab) {
          setError("Popup blocked. Copy the Azure AD sign-in URL below and open it manually.");
        }
      } else {
        throw new Error("Unexpected response from server");
      }
    } catch (err) {
      setError(err.message);
      setStep("error");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Direct mode ───────────────────────────────────────────────────

  const handleStartDirect = async () => {
    if (submitting) return;
    try {
      setSubmitting(true);
      setError(null);
      setStep("loading");

      const res = await fetch("/api/oauth/kiro/enterprise-sso/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: directEmail.trim(),
          issuerURL: directIssuerUrl.trim(),
          clientID: directClientId.trim(),
          scopes: directScopes.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setSessionId(data.sessionId);
      setAzureAuthUrl(data.authUrl);
      setStep("azure_ad");
      const tab = window.open(data.authUrl, "_blank");
      if (!tab) {
        setError("Popup blocked. Copy the Azure AD sign-in URL below and open it manually.");
      }
    } catch (err) {
      setError(err.message);
      setStep("error");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Common Azure AD callback handling ─────────────────────────────

  const handleResolveAzureCallback = async () => {
    if (submitting) return;
    try {
      setSubmitting(true);
      setError(null);
      setSaving(true);
      setStep("saving");

      const res = await fetch("/api/oauth/kiro/enterprise-sso/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          callbackUrl: azureCallback.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.phase === "completed") {
        const saveRes = await fetch("/api/oauth/kiro/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refreshToken: data.result.refreshToken,
            accessToken: data.result.accessToken,
            expiresIn: data.result.expiresIn,
            email: data.result.email,
            authMethod: data.result.authMethod,
            clientId: data.result.clientID,
            tokenEndpoint: data.result.tokenEndpoint,
            issuerURL: data.result.issuerURL,
            scopes: data.result.scopes,
            provider: "AzureAD",
          }),
        });

        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveData.error);

        setStep("completed");
        setTimeout(() => onSuccess?.(), 1500);
      } else {
        throw new Error("Unexpected response from server");
      }
    } catch (err) {
      setError(err.message);
      setSaving(false);
      setStep("error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetStep = () => {
    setError(null);
    setAzureAuthUrl("");
    setSignInUrl("");
    setSessionId(null);
    setStep("mode_select");
  };

  const handleBackToModeSelect = () => {
    setError(null);
    setAzureAuthUrl("");
    setSignInUrl("");
    setSessionId(null);
    setStep("mode_select");
  };

  return (
    <Modal isOpen={isOpen} title="Connect Kiro via Microsoft 365" onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        {/* Loading */}
        {step === "loading" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">
                progress_activity
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Initializing...</h3>
            <p className="text-sm text-text-muted">
              Setting up Enterprise SSO authentication
            </p>
          </div>
        )}

        {/* Mode Selection */}
        {step === "mode_select" && (
          <>
            <p className="text-sm text-text-muted">
              Choose how to sign in with Microsoft 365:
            </p>
            <div className="grid grid-cols-1 gap-3">
              <button
                onClick={handleStartPortal}
                className="text-left p-4 rounded-lg border border-border hover:border-primary transition-colors cursor-pointer"
              >
                <h3 className="font-semibold mb-1">
                  Via Kiro Portal
                </h3>
                <p className="text-sm text-text-muted">
                  Sign in to the Kiro portal with your work email. The portal
                  will redirect to Microsoft for authentication. Recommended for
                  first-time setup.
                </p>
              </button>
              <button
                onClick={() => setStep("direct")}
                className="text-left p-4 rounded-lg border border-border hover:border-primary transition-colors cursor-pointer"
              >
                <h3 className="font-semibold mb-1">
                  Direct Azure AD Sign-in
                </h3>
                <p className="text-sm text-text-muted">
                  Enter your tenant details directly and sign in to Azure AD.
                  Use this if you already know your tenant ID and Kiro client
                  ID.
                </p>
              </button>
            </div>
            <Button onClick={onClose} variant="ghost" fullWidth>
              Cancel
            </Button>
          </>
        )}

        {/* Direct Azure AD Configuration */}
        {step === "direct" && (
          <>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                <div className="flex-1 text-sm space-y-1">
                  <p className="font-medium text-blue-900 dark:text-blue-100">
                    Enter your Azure AD tenant details
                  </p>
                  <p className="text-blue-800 dark:text-blue-200">
                    You can find these in the Kiro portal callback URL after
                    signing in once, or ask your IT admin for the Kiro app
                    registration details.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Email (login_hint)</label>
              <Input
                value={directEmail}
                onChange={(e) => setDirectEmail(e.target.value)}
                placeholder="user@company.com"
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Issuer URL</label>
              <Input
                value={directIssuerUrl}
                onChange={(e) => setDirectIssuerUrl(e.target.value)}
                placeholder="https://login.microsoftonline.com/{tenant-id}/v2.0"
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Client ID</label>
              <Input
                value={directClientId}
                onChange={(e) => setDirectClientId(e.target.value)}
                placeholder="Kiro application (client) ID"
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Scopes</label>
              <Input
                value={directScopes}
                onChange={(e) => setDirectScopes(e.target.value)}
                placeholder="openid profile email offline_access"
                className="font-mono text-xs"
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleStartDirect}
                fullWidth
                disabled={!directIssuerUrl.trim() || !directClientId.trim() || submitting}
              >
                {submitting ? "Connecting..." : "Sign in with Microsoft"}
              </Button>
              <Button onClick={handleBackToModeSelect} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </>
        )}

        {/* Phase 1: Portal Sign-In */}
        {step === "portal" && (
          <>
            <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">info</span>
                <div className="flex-1 text-sm space-y-1">
                  <p className="font-medium text-amber-900 dark:text-amber-100">
                    Step 1: Sign in to Kiro portal
                  </p>
                  <p className="text-amber-800 dark:text-amber-200">
                    Open the URL below and sign in with your Microsoft 365 work email.
                    After signing in, you will be redirected to a callback page showing
                    the sign-in URL &mdash; copy it from there and paste it below.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium mb-2">Open this URL in your browser:</p>
              <div className="flex gap-2">
                <Input value={signInUrl} readOnly className="flex-1 font-mono text-xs" />
                <Button
                  variant="secondary"
                  icon={copied === "signin_url" ? "check" : "content_copy"}
                  onClick={() => copy(signInUrl, "signin_url")}
                >
                  Copy
                </Button>
              </div>
            </div>

            <Button onClick={handleOpenPortal} fullWidth>
              Open Kiro Sign-In
            </Button>

            <div>
              <p className="text-sm font-medium mb-2">Paste the callback URL from the browser:</p>
              <p className="text-xs text-text-muted mb-2">
                After signing in successfully, you will be redirected to a callback
                capture page showing the full URL. Copy it from there and paste here.
              </p>
              <Input
                value={portalCallback}
                onChange={(e) => setPortalCallback(e.target.value)}
                placeholder="http://localhost:3128/signin/callback?issuer_url=..."
                className="font-mono text-xs"
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={handleResolvePortalCallback} fullWidth disabled={!portalCallback.trim() || submitting}>
                {submitting ? "Processing..." : "Continue"}
              </Button>
              <Button onClick={handleBackToModeSelect} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </>
        )}

        {/* Phase 2: Azure AD Login */}
        {step === "azure_ad" && (
          <>
            <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">info</span>
                <div className="flex-1 text-sm space-y-1">
                  <p className="font-medium text-amber-900 dark:text-amber-100">
                    Step 2: Sign in with Microsoft 365
                  </p>
                  <p className="text-amber-800 dark:text-amber-200">
                    A new tab has opened for Microsoft login. Complete the
                    authentication. Afterward, you will be redirected to a callback
                    page showing the final URL. Copy it and paste it below.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium mb-2">Azure AD sign-in URL:</p>
              <div className="flex gap-2">
                <Input value={azureAuthUrl} readOnly className="flex-1 font-mono text-xs" />
                <Button
                  variant="secondary"
                  icon={copied === "azure_url" ? "check" : "content_copy"}
                  onClick={() => copy(azureAuthUrl, "azure_url")}
                >
                  Copy
                </Button>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium mb-2">Paste the final callback URL:</p>
              <p className="text-xs text-text-muted mb-2">
                After completing the Microsoft login, you will be redirected to a
                callback page showing the full URL. Copy it from there and paste here.
              </p>
              <Input
                value={azureCallback}
                onChange={(e) => setAzureCallback(e.target.value)}
                placeholder="http://localhost:3128/oauth/callback?code=..."
                className="font-mono text-xs"
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={handleResolveAzureCallback} fullWidth disabled={!azureCallback.trim() || submitting}>
                {submitting ? "Processing..." : "Complete Login"}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}

        {/* Saving / Processing */}
        {step === "saving" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">
                progress_activity
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">
              {saving ? "Connecting..." : "Connected!"}
            </h3>
            <p className="text-sm text-text-muted">
              {saving
                ? "Exchanging tokens and saving your connection"
                : "Your Microsoft 365 account has been connected"}
            </p>
          </div>
        )}

        {/* Completed */}
        {step === "completed" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-green-600">check_circle</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connected Successfully!</h3>
            <p className="text-sm text-text-muted mb-4">
              Your Kiro account via Microsoft 365 has been connected.
            </p>
            <Button onClick={onClose} fullWidth>
              Done
            </Button>
          </div>
        )}

        {/* Error */}
        {step === "error" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-red-600">error</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connection Failed</h3>
            <p className="text-sm text-red-600 mb-4">{error}</p>
            <div className="flex gap-2">
              <Button onClick={handleResetStep} variant="secondary" fullWidth>
                Try Again
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

KiroEnterpriseSSOModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
