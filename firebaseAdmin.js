const admin = require("firebase-admin");

// 🔥 IMPORTANT : assigner à une variable
const serviceAccount = {
  type: "service_account",
  project_id: "santeplus-service",
  private_key_id: "xxx",
  private_key: "-----BEGIN PRIVATE KEY-----\nXXX\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-fbsvc@santeplus-service.iam.gserviceaccount.com",
};

// Initialisation Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const messaging = admin.messaging();

// 🔔 ENVOI NOTIF
async function sendPush(token, title, body) {
    try {
        await messaging.send({
            token,
            notification: {
                title,
                body
            }
        });

        console.log("🔔 Notification envoyée");

    } catch (err) {
        console.error("❌ Erreur push:", err);
    }
}

module.exports = { sendPush };
