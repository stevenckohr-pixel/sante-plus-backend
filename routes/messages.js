const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

/**
 * 📥 1. LIRE LE FIL D'ACTUALITÉ (Live Care Feed)
 * Récupère les messages et photos liés à un patient précis.
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
      // On récupère les messages avec les infos de l'expéditeur (Jointure SQL)
      const { data, error } = await supabase
          .from("messages")
          .select(`
              *,
              sender:profiles!messages_sender_id_fkey (nom, role, photo_url)
          `)
          .eq("patient_id", patient_id)
          .order("created_at", { ascending: true });

      if (error) throw error;

      // On nettoie les données pour le Frontend
      const cleanedMessages = data.map((m) => ({
        id: m.id,
        content: m.content,
        is_photo: m.is_photo,
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

/**
 * ❤️ 2. AJOUTER UNE RÉACTION (Cœur, Merci, etc.)
 */
router.post(
  "/react",
  middleware(["FAMILLE", "COORDINATEUR"]),
  async (req, res) => {
    const { message_id, reaction_type } = req.body;

    try {
      // 1. Récupération des réactions actuelles
      const { data: msg, error: fetchErr } = await supabase
        .from("messages")
        .select("reactions")
        .eq("id", message_id)
        .single();

      if (fetchErr) throw fetchErr;

      let reactions = msg.reactions || {};

      // 2. Incrémentation propre
      reactions[reaction_type] = (reactions[reaction_type] || 0) + 1;

      // 3. Mise à jour en base
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

/**
 * ✉️ 3. ENVOYER UN MESSAGE OU UNE PHOTO
 * Autorisé pour les Aidants (terrain) et les Coordinateurs.
 */
router.post(
    "/send",
    middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
    async (req, res) => {
        const { patient_id, content, is_photo, type_media, titre_media } = req.body;

        if (!content) {
            return res.status(400).json({ error: "Le contenu est vide" });
        }

        // ============================================
        // 🛡️ SÉCURITÉ : Vérifications selon le rôle
        // ============================================

        // Pour la FAMILLE : le patient doit lui appartenir
        if (req.user.role === "FAMILLE") {
            const { data: patient, error } = await supabase
                .from("patients")
                .select("id")
                .eq("id", patient_id)
                .eq("famille_user_id", req.user.userId)
                .single();

            if (error || !patient) {
                return res.status(403).json({ 
                    error: "Vous ne pouvez pas écrire sur ce dossier" 
                });
            }
        }

        // Pour l'AIDANT : il doit être assigné à ce patient dans le planning
        if (req.user.role === "AIDANT") {
            const { data: planning, error } = await supabase
                .from("planning")
                .select("id")
                .eq("patient_id", patient_id)
                .eq("aidant_id", req.user.userId)
                .maybeSingle();

            if (error || !planning) {
                return res.status(403).json({ 
                    error: "Vous n'êtes pas autorisé à envoyer un message à ce patient" 
                });
            }

            // Vérifier si l'aidant a une visite en cours pour ce patient
            const { data: activeVisit, error: visitErr } = await supabase
                .from("visites")
                .select("id")
                .eq("patient_id", patient_id)
                .eq("aidant_id", req.user.userId)
                .eq("statut", "En cours")
                .maybeSingle();

            // Pas d'erreur si pas de visite, juste on ne bloque pas
        }

        // Pour le COORDINATEUR : pas de restriction (peut tout faire)

        // ============================================
        // INSERTION DU MESSAGE
        // ============================================
        try {
            const messageData = {
                patient_id,
                sender_id: req.user.userId,
                content,
                is_photo: is_photo || false,
                reactions: {},
            };

            // Ajouter les champs optionnels si présents
            if (type_media) messageData.type_media = type_media;
            if (titre_media) messageData.titre_media = titre_media;

            const { error } = await supabase.from("messages").insert([messageData]);

            if (error) throw error;

            // ============================================
            // NOTIFICATION PUSH aux membres de la famille
            // ============================================
            const { data: patient } = await supabase
                .from("patients")
                .select("famille_user_id, nom_complet")
                .eq("id", patient_id)
                .single();

            if (patient && patient.famille_user_id && req.user.role !== "FAMILLE") {
                // Ne pas notifier la famille si c'est elle qui envoie le message
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
module.exports = router;
