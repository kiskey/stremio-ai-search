const crypto = require("crypto");

// Try to load dotenv, but don't fail if it's not available
try {
  require("dotenv").config();
} catch (error) {
  console.warn("dotenv module not found, continuing without .env file support");
}

// Get the encryption key from environment variables with fallback
const SECRET_KEY =
  process.env.ENCRYPTION_KEY ||
  "K1EfDDEuHqRapCq6F5YmgWs9PDTS36HInoROwXHR5xJLNsWYKjAZwitcRSQHT2aJNmRLqxBtY39EQdbvVl8HA0VMe8DXClIDNP9dmXivKeaz3JeYD3haZJUaMZUzSMJ2";

// Log a warning instead of crashing
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  console.warn(
    "WARNING: ENCRYPTION_KEY environment variable is missing or too short. Using fallback key. This is insecure for production!"
  );
}

// Encryption function
function encryptConfig(configData) {
  try {
    // Generate a random initialization vector
    const iv = crypto.randomBytes(16);

    // Create cipher using AES-256-CBC
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      Buffer.from(SECRET_KEY.slice(0, 32)),
      iv
    );

    // Encrypt the data
    let encrypted = cipher.update(configData, "utf8", "base64");
    encrypted += cipher.final("base64");

    // Return IV and encrypted data as a single base64 string
    return Buffer.from(iv.toString("hex") + ":" + encrypted).toString("base64");
  } catch (error) {
    console.error("Encryption error:", error);
    return null;
  }
}

// Decryption function
function decryptConfig(encryptedData) {
  try {
    // Check if encryptedData is a string
    if (typeof encryptedData !== "string") {
      console.error("Invalid encrypted data type:", typeof encryptedData);

      // If it's an object, try to use it directly (might be already parsed JSON)
      if (typeof encryptedData === "object" && encryptedData !== null) {
        console.warn(
          "Received object instead of encrypted string, returning stringified object"
        );
        return JSON.stringify(encryptedData);
      }

      return null;
    }

    // Decode the base64 string
    const buffer = Buffer.from(encryptedData, "base64").toString("utf8");

    // Split the IV and encrypted data
    const parts = buffer.split(":");
    if (parts.length !== 2) {
      throw new Error("Invalid encrypted data format");
    }

    const iv = Buffer.from(parts[0], "hex");
    const encrypted = parts[1];

    // Create decipher
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(SECRET_KEY.slice(0, 32)),
      iv
    );

    // Decrypt the data
    let decrypted = decipher.update(encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    console.error("Decryption error:", error);
    return null;
  }
}

module.exports = {
  encryptConfig,
  decryptConfig,
};
