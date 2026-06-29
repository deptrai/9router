// CA cert install — trust rootCA in macOS Keychain / Linux ca-certificates / Windows certmgr.
const { execSync } = require("child_process");
const { ROOT_CA_CERT_PATH } = require("./rootCA");
const { log, err } = require("../logger");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function trustCert() {
  if (!IS_WIN && !IS_MAC) {
    // Linux: copy to /usr/local/share/ca-certificates + update-ca-certificates
    try {
      execSync(`sudo cp "${ROOT_CA_CERT_PATH}" /usr/local/share/ca-certificates/9r-mitm-root.crt && sudo update-ca-certificates`, { stdio: "inherit" });
      log("🔐 Cert trusted (Linux)");
      return true;
    } catch (e) { err(`Linux cert trust failed: ${e.message}`); return false; }
  }
  if (IS_MAC) {
    try {
      execSync(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${ROOT_CA_CERT_PATH}"`, { stdio: "inherit" });
      log("🔐 Cert trusted (macOS Keychain)");
      return true;
    } catch (e) { err(`macOS cert trust failed: ${e.message}`); return false; }
  }
  if (IS_WIN) {
    try {
      execSync(`certutil -addstore -f "ROOT" "${ROOT_CA_CERT_PATH}"`, { stdio: "inherit" });
      log("🔐 Cert trusted (Windows ROOT store)");
      return true;
    } catch (e) { err(`Windows cert trust failed: ${e.message}`); return false; }
  }
  return false;
}

function untrustCert() {
  if (IS_MAC) {
    try {
      execSync(`sudo security delete-certificate -c "9R MITM Client Root CA"`, { stdio: "ignore" });
      log("🔐 Cert removed from macOS Keychain");
    } catch { /* not present */ }
  } else if (!IS_WIN) {
    // Linux: remove from ca-certificates + update.
    try {
      execSync(`sudo rm -f /usr/local/share/ca-certificates/9r-mitm-root.crt && sudo update-ca-certificates --fresh`, { stdio: "ignore" });
      log("🔐 Cert removed from Linux ca-certificates");
    } catch { /* not present */ }
  } else if (IS_WIN) {
    try {
      execSync(`certutil -delstore "ROOT" "9R MITM Client Root CA"`, { stdio: "ignore" });
      log("🔐 Cert removed from Windows ROOT store");
    } catch { /* not present */ }
  }
}

module.exports = { trustCert, untrustCert };
