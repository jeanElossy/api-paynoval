// src/utils/crypto.js
const crypto = require('crypto');

const HMAC_SECRET = process.env.HMAC_SECRET;
if (!HMAC_SECRET) {
  throw new Error('HMAC_SECRET requis pour les opérations de hachage');
}

/**
 * Génère un HMAC SHA-256 hexadécimal pour la donnée fournie.
 */
const sign = (data) => {
  return crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex');
};

/**
 * Chiffre un texte avec AES-256-GCM.
 * Renvoie un objet { iv, authTag, ciphertext } en hex.
 */
const encrypt = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(HMAC_SECRET, 'hex'), iv);
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext
  };
};

/**
 * Déchiffre un objet chiffré par AES-256-GCM.
 */
const decrypt = ({ iv, authTag, ciphertext }) => {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(HMAC_SECRET, 'hex'),
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
};

module.exports = { sign, encrypt, decrypt };