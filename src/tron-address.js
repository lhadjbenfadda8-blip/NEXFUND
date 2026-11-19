const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  let bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (let i = 0; i < value.length && value[i] === "1"; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

// Validates Base58Check checksum and TRON mainnet address prefix (0x41).
export async function isValidTronAddress(value) {
  if (typeof value !== "string" || value.length !== 34 || value[0] !== "T") return false;
  const decoded = decodeBase58(value);
  if (!decoded || decoded.length !== 25 || decoded[0] !== 0x41) return false;
  const payload = decoded.slice(0, 21);
  const first = await sha256(payload);
  const second = await sha256(first);
  for (let i = 0; i < 4; i++) if (decoded[21 + i] !== second[i]) return false;
  return true;
}
