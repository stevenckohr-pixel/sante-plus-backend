const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");
const { createNotification } = require("./notifications");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

/**
 * 📥 1. LIRE LES MESSAGES AVEC RÉPONSES (THREADING)
 */
router.get(
  "/",
  middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
  async (req, res) => {
    const { patient_id } = req.query;

    if (!patient_id) {
      return res.status(400).json({ error: "ID du patient manquant" });
    }

    try {
      const { data, error } = await supabase
        .from("messages")
        .select(`
          *,
          sender:profiles!messages_sender_id_fkey (id, nom, role, photo_url),
          parent:sender!messages_reply_to_id_fkey (id, content, sender:profiles!sender_id (nom))
        `)
        .eq("patient_id", patient_id)
        .order("created_at", { ascending: true });

      if (error) throw error;

      const messagesMap = new Map();
      const rootMessages = [];

      data.forEach(msg => {
        const cleanMsg = {
          id: msg.id,
          content: msg.content,
          is_photo: msg.is_photo,
          photos: msg.photos || [],
          reply_to_id: msg.reply_to_id,
          reactions: msg.reactions || {},
          created_at: msg.created_at,
          sender_id: msg.sender_id,
          sender_name: msg.sender?.nom || "Système",
          sender_role: msg.sender?.role || "COORDINATEUR",
          sender_photo: msg.sender?.photo_url || null,
          replies: []
        };
        messagesMap.set(msg.id, cleanMsg);
      });

      for (const msg of data) {
        if (msg.reply_to_id && messagesMap.has(msg.reply_to_id)) {
          messagesMap.get(msg.reply_to_id).replies.push(messagesMap.get(msg.id));
        } else if (!msg.reply_to_id) {
          rootMessages.push(messagesMap.get(msg.id));
        }
      }

      rootMessages.forEach(msg => {
        msg.replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      });
      rootMessages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      res.json(rootMessages);
    } catch (err) {
      console.error("❌ Erreur lecture messages:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ✉️ 2. ENVOYER UN MESSAGE (TEXTE OU PHOTO AVEC RÉPONSE CIBLÉE)
 */
router.post(
  "/send",
  middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
  upload.array('photos', 5),
  async (req, res) => {
    const { patient_id, content, reply_to_id, type_media, titre_media } = req.body;
    const photoFiles = req.files || [];

    if (!content && photoFiles.length === 0) {
      return res.status(400).json({ error: "Le message ou une photo est requis" });
    }

    // Sécurité : vérifications selon le rôle
    if (req.user.role === "FAMILLE") {
      const { data: patient, error } = await supabase
        .from("patients")
        .select("id")
        .eq("id", patient_id)
        .eq("famille_user_id", req.user.userId)
        .single();

      if (error || !patient) {
        return res.status(403).json({ error: "Vous ne pouvez pas écrire sur ce dossier" });
      }
    }

    if (req.user.role === "AIDANT") {
      const { data: planning, error } = await supabase
        .from("planning")
        .select("id")
        .eq("patient_id", patient_id)
        .eq("aidant_id", req.user.userId)
        .maybeSingle();

      if (error || !planning) {
        return res.status(403).json({ error: "Vous n'êtes pas autorisé à envoyer un message à ce patient" });
      }
    }

    // Upload des photos
    let uploadedPhotos = [];
    for (const photo of photoFiles) {
      if (photo.size > 10 * 1024 * 1024) continue;
      
      const fileName = `messages/${patient_id}_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("preuves")
        .upload(fileName, photo.buffer, {
          contentType: photo.mimetype || 'image/jpeg',
          upsert: false
        });
      
      if (!uploadError) {
        const { data: urlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
        uploadedPhotos.push(urlData.publicUrl);
      }
    }

    try {
      const messageData = {
        patient_id,
        sender_id: req.user.userId,
        content: content || (uploadedPhotos.length > 0 ? uploadedPhotos[0] : ""),
        is_photo: uploadedPhotos.length > 0,
        photos: uploadedPhotos,
        reactions: {},
        created_at: new Date()
      };

      if (reply_to_id && reply_to_id !== 'null' && reply_to_id !== 'undefined') {
        const { data: parentMsg } = await supabase
          .from("messages")
          .select("id")
          .eq("id", reply_to_id)
          .maybeSingle();
        
        if (parentMsg) messageData.reply_to_id = reply_to_id;
      }

      if (type_media) messageData.type_media = type_media;
      if (titre_media) messageData.titre_media = titre_media;

      const { error } = await supabase.from("messages").insert([messageData]);
      if (error) throw error;

      // Notification
      const { data: patient } = await supabase
        .from("patients")
        .select("famille_user_id, nom_complet")
        .eq("id", patient_id)
        .single();

      if (patient && patient.famille_user_id && req.user.role !== "FAMILLE") {
        let notificationTitle = "📝 Nouveau message";
        let notificationBody = `Nouveau message dans le journal de ${patient.nom_complet}`;

        if (uploadedPhotos.length > 0) {
          notificationTitle = "📸 Nouvelle photo";
          notificationBody = `${uploadedPhotos.length} nouvelle(s) photo(s) ajoutée(s)`;
        }

        sendPushNotification(patient.famille_user_id, notificationTitle, notificationBody, "/#feed");
        if (createNotification) {
          await createNotification(patient.famille_user_id, notificationTitle, notificationBody, "message", "/#feed");
        }
      }

      res.json({ status: "success", photos: uploadedPhotos });
    } catch (err) {
      console.error("❌ Erreur envoi message:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ❤️ 3. AJOUTER UNE RÉACTION
 */
router.post(
  "/react",
  middleware(["FAMILLE", "COORDINATEUR", "AIDANT"]),
  async (req, res) => {
    const { message_id, reaction_type } = req.body;

    try {
      const { data: msg, error: fetchErr } = await supabase
        .from("messages")
        .select("reactions")
        .eq("id", message_id)
        .single();

      if (fetchErr) throw fetchErr;

      let reactions = msg.reactions || {};
      reactions[reaction_type] = (reactions[reaction_type] || 0) + 1;

      const { error: updateErr } = await supabase
        .from("messages")
        .update({ reactions })
        .eq("id", message_id);

      if (updateErr) throw updateErr;

      res.json({ status: "success", reactions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * 🚩 4. SIGNALER UN MESSAGE
 */
router.post(
  "/report",
  middleware(["FAMILLE"]),
  async (req, res) => {
    const { message_id, description } = req.body;

    try {
      const { data: message, error: msgErr } = await supabase
        .from("messages")
        .select("id, sender_id, patient:patients(famille_user_id)")
        .eq("id", message_id)
        .single();

      if (msgErr || !message) {
        return res.status(404).json({ error: "Message introuvable" });
      }

      if (message.patient?.famille_user_id !== req.user.userId) {
        return res.status(403).json({ error: "Non autorisé" });
      }

      const { error: reportErr } = await supabase
        .from("signalements")
        .insert([{
          message_id,
          signalant_id: req.user.userId,
          description,
          statut: "En attente"
        }]);

      if (reportErr) throw reportErr;

      const { data: coordinators } = await supabase
        .from("profiles")
        .select("id")
        .eq("role", "COORDINATEUR");

      if (coordinators) {
        for (const coord of coordinators) {
          sendPushNotification(coord.id, "🚩 Signalement", "Un message a été signalé", "/#dashboard");
        }
      }

      res.json({ status: "success" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
