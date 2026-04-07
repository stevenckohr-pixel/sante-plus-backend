// backend/routes/messages.js - VERSION COMPLÈTE AVEC LA ROUTE PHOTO

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");  
const { createNotification } = require("./notifications");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// 📥 1. LIRE LE FIL D'ACTUALITÉ
// ============================================================
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
              sender:profiles!messages_sender_id_fkey (nom, role, photo_url)
          `)
          .eq("patient_id", patient_id)
          .order("created_at", { ascending: true });

      if (error) throw error;

      const cleanedMessages = data.map((m) => ({
        id: m.id,
        content: m.content,
        is_photo: m.is_photo,
        photo_url: m.photo_url || null,
        reply_to_id: m.reply_to_id || null,
        reactions: m.reactions || {},
        created_at: m.created_at,
        sender_name: m.sender ? m.sender.nom : "Système",
        sender_role: m.sender ? m.sender.role : "COORDINATEUR",
        sender_photo: m.sender ? m.sender.photo_url : null,
      }));

      res.json(cleanedMessages);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ============================================================
// ❤️ 2. AJOUTER UNE RÉACTION
// ============================================================
router.post(
  "/react",
  middleware(["FAMILLE", "COORDINATEUR"]),
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
  },
);

// ============================================================
// ✉️ 3. ENVOYER UN MESSAGE TEXTE
// ============================================================
router.post(
    "/send",
    middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
    async (req, res) => {
        const { patient_id, content, is_photo, type_media, titre_media, reply_to_id } = req.body;

        if (!content) {
            return res.status(400).json({ error: "Le contenu est vide" });
        }

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

        try {
            const messageData = {
                patient_id,
                sender_id: req.user.userId,
                content,
                is_photo: is_photo || false,
                reactions: {},
            };

            if (type_media) messageData.type_media = type_media;
            if (titre_media) messageData.titre_media = titre_media;
            if (reply_to_id) messageData.reply_to_id = reply_to_id;

            const { error } = await supabase.from("messages").insert([messageData]);

            if (error) throw error;

            const { data: patient } = await supabase
                .from("patients")
                .select("famille_user_id, nom_complet")
                .eq("id", patient_id)
                .single();

            if (patient && patient.famille_user_id && req.user.role !== "FAMILLE") {
                let notificationTitle = "📝 Nouveau message";
                let notificationBody = `Nouveau message dans le journal de ${patient.nom_complet}`;

                if (is_photo) {
                    notificationTitle = "📸 Nouvelle photo";
                    notificationBody = `Une nouvelle photo a été ajoutée au journal de ${patient.nom_complet}`;
                }

                if (type_media === 'DOCUMENT') {
                    notificationTitle = "📄 Nouveau document";
                    notificationBody = `Un nouveau document a été ajouté pour ${patient.nom_complet}`;
                }

                sendPushNotification(
                    patient.famille_user_id,
                    notificationTitle,
                    notificationBody,
                    "/#feed"
                );
            }

            res.json({ status: "success" });

        } catch (err) {
            console.error("❌ Erreur envoi message:", err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

// ============================================================
// 📸 4. ENVOYER UNE PHOTO (NOUVELLE ROUTE)
// ============================================================
router.post(
    "/send-photo",
    middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
    upload.single("photo"),
    async (req, res) => {
        console.log("🔵 [send-photo] Route appelée");
        console.log("🔵 Body:", req.body);
        console.log("🔵 File:", req.file ? req.file.originalname : "AUCUN FICHIER");
        
        const { patient_id, reply_to_id, caption } = req.body;
        const photoFile = req.file;

        if (!photoFile) {
            console.error("❌ Aucune photo reçue");
            return res.status(400).json({ error: "Photo requise" });
        }

        if (!patient_id) {
            console.error("❌ patient_id manquant");
            return res.status(400).json({ error: "ID patient requis" });
        }

        // Vérifications de sécurité
        try {
            if (req.user.role === "FAMILLE") {
                const { data: patient, error } = await supabase
                    .from("patients")
                    .select("id")
                    .eq("id", patient_id)
                    .eq("famille_user_id", req.user.userId)
                    .single();

                if (error || !patient) {
                    return res.status(403).json({ error: "Action non autorisée" });
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
                    return res.status(403).json({ error: "Vous n'êtes pas assigné à ce patient" });
                }
            }

            // Upload vers Supabase Storage
            const fileName = `messages/${patient_id}/${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
            
            console.log("📤 Upload vers:", fileName);
            
            const { error: uploadError } = await supabase.storage
                .from("preuves")
                .upload(fileName, photoFile.buffer, {
                    contentType: photoFile.mimetype || "image/jpeg",
                    upsert: false,
                });

            if (uploadError) {
                console.error("❌ Erreur upload:", uploadError);
                throw uploadError;
            }

            const { data: urlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
            const photoUrl = urlData.publicUrl;
            
            console.log("✅ Photo uploadée:", photoUrl);

            // Insertion du message
            const messageData = {
                patient_id,
                sender_id: req.user.userId,
                content: caption || "",
                photo_url: photoUrl,
                is_photo: true,
                type_media: "PHOTO",
                reply_to_id: reply_to_id || null,
                reactions: {},
            };

            const { error: insertError } = await supabase.from("messages").insert([messageData]);

            if (insertError) {
                console.error("❌ Erreur insertion:", insertError);
                throw insertError;
            }

            // Notification à la famille
            const { data: patient } = await supabase
                .from("patients")
                .select("famille_user_id, nom_complet")
                .eq("id", patient_id)
                .single();

            if (patient && patient.famille_user_id && req.user.role !== "FAMILLE") {
                sendPushNotification(
                    patient.famille_user_id,
                    "📸 Nouvelle photo",
                    `Une nouvelle photo a été ajoutée au journal de ${patient.nom_complet}`,
                    "/#feed"
                );
            }

            console.log("✅ Photo envoyée avec succès");
            res.json({ status: "success", photo_url: photoUrl });

        } catch (err) {
            console.error("❌ Erreur send-photo:", err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

module.exports = router;
