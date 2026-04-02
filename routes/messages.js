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
    const { patient_id, content, is_photo } = req.body;

    if (!content) return res.status(400).json({ error: "Le contenu est vide" });

    // ============================================
    // 🛡️ SÉCURITÉ : Vérifier que la famille n'écrit que sur SON dossier
    // ============================================
    if (req.user.role === "FAMILLE") {
      const { data: patient } = await supabase
        .from("patients")
        .select("id")
        .eq("id", patient_id)
        .eq("famille_user_id", req.user.userId)
        .single();
      
      if (!patient) {
        return res.status(403).json({ error: "Vous ne pouvez pas écrire sur ce dossier" });
      }
    }

       if (req.user.role === "AIDANT") {
            const { data: planning } = await supabase
                .from("planning")
                .select("id")
                .eq("patient_id", patient_id)
                .eq("aidant_id", req.user.userId)
                .single();
            
            if (!planning) {
                return res.status(403).json({ 
                    error: "Vous ne pouvez pas envoyer de message à ce patient" 
                });
            }
        }

    try {
      const { error } = await supabase.from("messages").insert([
        {
          patient_id,
          sender_id: req.user.userId,
          content,
          is_photo: is_photo || false,
          reactions: {},
        },
      ]);

      if (error) throw error;
      res.json({ status: "success" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);
module.exports = router;
