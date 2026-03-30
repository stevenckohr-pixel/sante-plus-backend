const axios = require("axios");
const webpush = require("web-push");
const supabase = require("./supabaseClient");

// Configuration du moteur Push avec les clés de sécurité VAPID
webpush.setVapidDetails(
  "mailto: stevenckohr@gmail.com", // Email de contact pour les serveurs de push (Google/Apple)
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

/**
 * 🔔 ENVOYER UNE NOTIFICATION PUSH NATIVE (WhatsApp Style)
 * @param {string} userId - ID de l'utilisateur (Profiles) à notifier
 * @param {string} title - Titre de la notification
 * @param {string} message - Corps du message
 * @param {string} url - Lien vers lequel rediriger au clic
 */
async function sendPushNotification(userId, title, message, url = "/") {
  try {
    // 1. Récupération de tous les terminaux enregistrés pour cet utilisateur
    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("*")
      .eq("user_id", userId);

    if (error || !subs || subs.length === 0) return;

    const payload = JSON.stringify({ title, message, url });

    // 2. Envoi simultané à tous les appareils (Promesses en parallèle)
    const notifications = subs.map((sub) => {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { auth: sub.auth, p256dh: sub.p256dh },
      };

      return webpush.sendNotification(subscription, payload).catch((err) => {
        // 410 = Gone / 404 = Not Found : L'utilisateur a désinstallé l'app ou réinitialisé son tel
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(
            `🧹 Nettoyage : Suppression d'un jeton push expiré pour l'user ${userId}`,
          );
          return supabase.from("push_subscriptions").delete().eq("id", sub.id);
        }
        console.error("⚠️ Erreur technique envoi Push:", err.statusCode);
      });
    });

    await Promise.all(notifications);
  } catch (err) {
    console.error("❌ Erreur globale sendPushNotification:", err.message);
  }
}

/**
 * 📧 ENVOYER UN EMAIL VIA BREVO API
 * @param {string} toEmail - Email du destinataire
 * @param {string} subject - Sujet du mail
 * @param {string} htmlContent - Contenu au format HTML
 */
async function sendEmailAPI(toEmail, subject, htmlContent) {
  if (!process.env.BREVO_API_KEY) {
    console.error("❌ Erreur : Clé API Brevo manquante dans le .env");
    return false;
  }

  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
        {
        sender: {
          name: "Santé Plus Services",
          email: "contact@terre-des-enfants-epanouis.org", // 
        },
        to: [{ email: toEmail }],
        subject: subject,
        htmlContent: htmlContent,
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );
    console.log(`📩 Email envoyé avec succès à : ${toEmail}`);
    return true;
  } catch (error) {
    const errorMsg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error("❌ Échec envoi Email Brevo:", errorMsg);
    return false;
  }
}

module.exports = { sendEmailAPI, sendPushNotification };
