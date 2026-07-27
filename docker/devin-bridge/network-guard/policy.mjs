export const DEVIN_ALLOWED_SUFFIXES = Object.freeze([".devin.ai", ".cognition.ai"]);
export const DEVIN_ALLOWED_EXACT_HOSTS = Object.freeze([
  "server.codeium.com",
  "unleash.codeium.com",
]);

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export function isAllowedGuardHostname(hostname, policy = "deny-all") {
  if (policy !== "devin") return false;
  const value = normalizeHostname(hostname);
  if (!value) return false;
  if (DEVIN_ALLOWED_EXACT_HOSTS.includes(value)) return true;
  return DEVIN_ALLOWED_SUFFIXES.some(
    (suffix) => value === suffix.slice(1) || value.endsWith(suffix)
  );
}
