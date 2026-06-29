// Root CA + leaf cert generation — standalone (no 9router paths dep).
const path = require("path");
const fs = require("fs");
const forge = require("node-forge");
const { MITM_DIR } = require("../paths");

const ROOT_CA_KEY_PATH = path.join(MITM_DIR, "rootCA.key");
const ROOT_CA_CERT_PATH = path.join(MITM_DIR, "rootCA.crt");

function isCertExpired(certPath) {
  try {
    const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, "utf8"));
    const expiryThreshold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return cert.validity.notAfter < expiryThreshold;
  } catch {
    return true;
  }
}

async function generateRootCA() {
  const exists = fs.existsSync(ROOT_CA_KEY_PATH) && fs.existsSync(ROOT_CA_CERT_PATH);
  if (exists && !isCertExpired(ROOT_CA_CERT_PATH)) {
    return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
  }
  if (exists) {
    try { fs.unlinkSync(ROOT_CA_KEY_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(ROOT_CA_CERT_PATH); } catch { /* ignore */ }
  }
  if (!fs.existsSync(MITM_DIR)) fs.mkdirSync(MITM_DIR, { recursive: true });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "9R MITM Client Root CA" },
    { name: "organizationName", value: "9Router" },
    { name: "countryName", value: "US" }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // P7: protect private key at rest with mode 0o600 (owner read/write only).
  fs.writeFileSync(ROOT_CA_KEY_PATH, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(ROOT_CA_CERT_PATH, forge.pki.certificateToPem(cert));
  return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
}

function loadRootCA() {
  if (!fs.existsSync(ROOT_CA_KEY_PATH) || !fs.existsSync(ROOT_CA_CERT_PATH)) {
    throw new Error("Root CA not found. Generate it first (run setup).");
  }
  const keyPem = fs.readFileSync(ROOT_CA_KEY_PATH, "utf8");
  const certPem = fs.readFileSync(ROOT_CA_CERT_PATH, "utf8");
  return { key: forge.pki.privateKeyFromPem(keyPem), cert: forge.pki.certificateFromPem(certPem) };
}

function generateLeafCert(domain, rootCA) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Math.floor(Math.random() * 1000000).toString();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: "commonName", value: domain }]);
  cert.setIssuer(rootCA.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    { name: "subjectAltName", altNames: [
      { type: 2, value: domain },
      { type: 2, value: `*.${domain}` }
    ] }
  ]);
  cert.sign(rootCA.key, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

function getCertForDomain(domain) {
  try {
    const rootCA = loadRootCA();
    const leafCert = generateLeafCert(domain, rootCA);
    return { key: leafCert.key, cert: leafCert.cert };
  } catch (error) {
    console.error(`Failed to generate cert for ${domain}:`, error.message);
    return null;
  }
}

module.exports = {
  generateRootCA, loadRootCA, generateLeafCert, isCertExpired,
  getCertForDomain, ROOT_CA_CERT_PATH, ROOT_CA_KEY_PATH,
};
