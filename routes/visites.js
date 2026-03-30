const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI, sendPushNotification } = require("../utils");

/**
 * ▶️ 1. DÉMARRER UNE VISITE
 */
router.post("/start", middleware(["AIDANT"]), async (req, res) => {
  const { patient_id, gps_start } = req.body;

  try {
    const { data: visite, error } = await supabase
      .from("visites")
      .insert([{
        patient_id,
        aidant_id: req.user.userId,
        heure_debut: new Date(),
        gps_start: gps_start,
        statut_validation: "En cours",
      }])
      .select(`*, patient:patients(nom_complet, famille_user_id, famille:famille_user_id(email, nom))`)
      .single();

    if (error) throw error;

    if (visite.patient && visite.patient.famille_user_id) {
      sendPushNotification(
        visite.patient.famille_user_id,
        "🔔 Arrivée de l'aidant",
        `L'intervenant est arrivé chez ${visite.patient.nom_complet}.`,
        "/#visits"
      );
    }

    res.json({ status: "success", visite_id: visite.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ⏹️ 2. TERMINER UNE VISITE (AVEC AUTO-FEED)
 * Cette route ferme la visite ET remplit le journal de soins automatiquement
 */
router.post("/end", middleware(["AIDANT"]), async (req, res) => {
  const { visite_id, activites_faites, notes, gps_end, humeur } = req.body;
  const photoFile = req.files ? req.files.find((f) => f.fieldname === "photo_visite") : null;

  if (!photoFile) return res.status(400).json({ error: "Photo obligatoire." });

  try {
    // 1. Upload de la photo de preuve
    const fileName = `visites/${visite_id}_${Date.now()}.jpg`;
    await supabase.storage.from("preuves").upload(fileName, photoFile.buffer, { contentType: photoFile.mimetype });
    const { data: publicUrlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
    const photoUrl = publicUrlData.publicUrl;

    // 2. Mise à jour de la table 'visites'
    const { data: v, error: updateError } = await supabase
      .from("visites")
      .update({
        heure_fin: new Date(),
        activites_faites: JSON.parse(activites_faites || "[]"),
        notes,
        humeur,
        photo_url: photoUrl,
        gps_end: gps_end,
        statut_validation: "En attente",
      })
      .eq("id", visite_id)
      .select(`*, patient:patients(nom_complet, famille_user_id)`)
      .single();

    if (updateError) throw updateError;

    // ============================================================
    // 💥 AUTOMATISATION DU LIVE CARE FEED (JOURNAL)
    // ============================================================
    
    // A. Insertion de la PHOTO Polaroid dans le feed
    await supabase.from("messages").insert([{
        patient_id: v.patient_id,
        sender_id: req.user.userId,
        content: photoUrl,
        is_photo: true
    }]);

    // B. Insertion du RÉSUMÉ (Humeur | Notes) pour le décodage Front
    await supabase.from("messages").insert([{
        patient_id: v.patient_id,
        sender_id: req.user.userId,
        content: `${humeur}|${notes}`,
        is_photo: false
    }]);

    // 3. Notification Push à la famille
    if (v.patient && v.patient.famille_user_id) {
      sendPushNotification(
        v.patient.famille_user_id,
        "📸 Nouveau rapport de soins",
        `L'intervention pour ${v.patient.nom_complet} est terminée. État : ${humeur}.`,
        "/#feed"
      );
    }

    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur fin de visite:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ 3. VALIDER UNE VISITE
 */
router.post("/validate", middleware(["COORDINATEUR"]), async (req, res) => {
  const { visite_id, statut } = req.body;

  try {
    const { data: visite, error } = await supabase
        .from("visites")
        .update({ statut_validation: statut })
        .eq("id", visite_id)
        .select(`*, patient:patients(nom_complet, famille_user_id)`)
        .single();

    if (error) throw error;

    if (statut === "Validé" && visite.patient.famille_user_id) {
      sendPushNotification(
        visite.patient.famille_user_id,
        "✅ Bilan validé par la coordination",
        `Le rapport pour ${visite.patient.nom_complet} a été certifié conforme.`,
        "/#feed"
      );
    }

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📂 4. LIRE LES VISITES (Filtrage de sécurité)
 */
router.get("/", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    let query = supabase.from("visites").select(`
        *,
        patient:patients (nom_complet, adresse),
        aidant:aidant_id (nom)
    `);

    if (req.user.role === "AIDANT") {
      query = query.eq("aidant_id", req.user.userId);
    } else if (req.user.role === "FAMILLE") {
      const { data: p } = await supabase.from("patients").select("id").eq("famille_user_id", req.user.userId).maybeSingle();
      if (!p) return res.json([]);
      query = query.eq("patient_id", p.id).eq("statut_validation", "Validé");
    }

    const { data, error } = await query.order("heure_debut", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

module.exports = router;
