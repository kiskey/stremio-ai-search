const crypto = require("crypto");

// Try to load dotenv, but don't fail if it's not available
try {
  require("dotenv").config();
} catch (error) {
  console.warn("dotenv module not found, continuing without .env file support");
}

// Get the encryption key from environment variables with NO fallback
const SECRET_KEY = process.env.ENCRYPTION_KEY;

// Log a critical error if the key is missing or too short
if (!SECRET_KEY) {
  console.error(
    "CRITICAL ERROR: ENCRYPTION_KEY environment variable is missing. Encryption/decryption will fail!"
  );
} else if (SECRET_KEY.length < 32) {
  console.error(
    "CRITICAL ERROR: ENCRYPTION_KEY environment variable is too short (must be at least 32 characters). Encryption/decryption will fail!"
  );
}

// Encryption function
function encryptConfig(configData) {
  try {
    if (!SECRET_KEY || SECRET_KEY.length < 32) {
      throw new Error(
        "Invalid encryption key - must be at least 32 characters"
      );
    }

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
    // Make sure the format is consistent: iv:encrypted
    const result = iv.toString("hex") + ":" + encrypted;

    // URL-safe base64 encoding
    return Buffer.from(result)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch (error) {
    console.error("Encryption error:", error);
    return null;
  }
}

// Decryption function
function decryptConfig(encryptedData) {
  try {
    if (!SECRET_KEY || SECRET_KEY.length < 32) {
      throw new Error(
        "Invalid encryption key - must be at least 32 characters"
      );
    }

    // Check if encryptedData is a string
    if (typeof encryptedData !== "string") {
      console.error("Invalid encrypted data type:", typeof encryptedData);
      return null;
    }

    // Add more detailed logging for debugging
    console.log(
      `Attempting to decrypt data of length: ${encryptedData.length}`
    );

    // Restore base64 padding and standard characters
    let base64Data = encryptedData.replace(/-/g, "+").replace(/_/g, "/");

    // Add padding if needed
    while (base64Data.length % 4) {
      base64Data += "=";
    }

    // Decode the base64 string
    let buffer;
    try {
      buffer = Buffer.from(base64Data, "base64").toString("utf8");
    } catch (e) {
      console.error("Base64 decoding error:", e);
      return null;
    }

    // Check if buffer is valid
    if (!buffer || buffer.length === 0) {
      console.error("Empty buffer after base64 decoding");
      return null;
    }

    // Split the IV and encrypted data
    const parts = buffer.split(":");
    if (parts.length !== 2) {
      console.error(
        "Invalid encrypted data format (expected format: 'iv:encrypted'). Got parts:",
        parts.length,
        "Buffer starts with:",
        buffer.substring(0, 20) + "..."
      );
      return null;
    }

    const iv = Buffer.from(parts[0], "hex");
    if (iv.length !== 16) {
      console.error("Invalid IV length:", iv.length, "Expected: 16");
      return null;
    }

    const encrypted = parts[1];
    if (!encrypted || encrypted.length === 0) {
      console.error("Empty encrypted data part");
      return null;
    }

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
    console.error(
      "Decryption error:",
      error,
      "Data:",
      encryptedData ? encryptedData.substring(0, 20) + "..." : "null"
    );
    return null;
  }
}

// Add this function to validate encrypted data format
function isValidEncryptedFormat(encryptedData) {
  if (typeof encryptedData !== "string" || encryptedData.length < 10) {
    return false;
  }

  try {
    // Restore base64 padding and standard characters
    let base64Data = encryptedData.replace(/-/g, "+").replace(/_/g, "/");

    // Add padding if needed
    while (base64Data.length % 4) {
      base64Data += "=";
    }

    // Decode the base64 string
    const buffer = Buffer.from(base64Data, "base64").toString("utf8");

    // Check if it has the expected format (iv:encrypted)
    return buffer.includes(":");
  } catch (e) {
    return false;
  }
}

module.exports = {
  encryptConfig,
  decryptConfig,
  isValidEncryptedFormat,
};
