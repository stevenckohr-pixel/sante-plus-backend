const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI, sendPushNotification } = require("../utils"); // Importation des deux outils

/**
 * ▶️ 1. DÉMARRER UNE VISITE
 * Déclenche : 1 Push (Immédiat) + 1 Email (Info)
 */
router.post("/start", middleware(["AIDANT"]), async (req, res) => {
  const { patient_id, gps_start } = req.body;

  try {
    const { data: visite, error } = await supabase
      .from("visites")
      .insert([
        {
          patient_id,
          aidant_id: req.user.userId,
          heure_debut: new Date(),
          gps_start: gps_start,
          statut_validation: "En cours",
        },
      ])
      .select(
        `*, patient:patients(nom_complet, famille_user_id, famille:famille_user_id(email, nom))`,
      )
      .single();

    if (error) throw error;

    // --- LOGIQUE DE NOTIFICATION WHATSAPP STYLE ---
    if (visite.patient && visite.patient.famille_user_id) {
      const patientName = visite.patient.nom_complet;

      // 1. Envoi du PUSH (Vibre sur le téléphone)
      sendPushNotification(
        visite.patient.famille_user_id,
        "🔔 Arrivée de l'aidant",
        `Notre intervenant vient d'arriver chez ${patientName}.`,
        "/#visits",
      );

      // 2. Envoi du MAIL (Trace écrite)
      if (visite.patient.famille.email) {
        const html = `<div style="font-family: sans-serif; padding:20px; border:1px solid #eee; border-radius:15px;">
                <h2 style="color: #16a34a;">Début de prise en charge</h2>
                <p>Bonjour, nous vous confirmons que l'aidant est arrivé au domicile de <b>${patientName}</b> à ${new Date().toLocaleTimeString("fr-FR")}.</p>
            </div>`;
        sendEmailAPI(
          visite.patient.famille.email,
          `🔔 Début de visite - ${patientName}`,
          html,
        );
      }
    }

    res.json({ status: "success", visite_id: visite.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ⏹️ 2. TERMINER UNE VISITE
 * Déclenche : 1 Push "Photo disponible"
 */
router.post("/end", middleware(["AIDANT"]), async (req, res) => {
  const { visite_id, activites_faites, notes, gps_end, humeur } = req.body;
  const photoFile = req.files
    ? req.files.find((f) => f.fieldname === "photo_visite")
    : null;

  if (!photoFile) return res.status(400).json({ error: "Photo obligatoire." });

  try {
    const fileName = `visites/${visite_id}_${Date.now()}.jpg`;
    await supabase.storage
      .from("preuves")
      .upload(fileName, photoFile.buffer, { contentType: photoFile.mimetype });
    const { data: publicUrlData } = supabase.storage
      .from("preuves")
      .getPublicUrl(fileName);

    // Mise à jour et récupération des infos de la famille pour notifier
    const { data: visiteUpdate, error: updateError } = await supabase
      .from("visites")
      .update({
        heure_fin: new Date(),
        activites_faites: JSON.parse(activites_faites || "[]"),
        notes,
        humeur,
        photo_url: publicUrlData.publicUrl,
        gps_end: gps_end,
        statut_validation: "En attente",
      })
      .eq("id", visite_id)
      .select(`*, patient:patients(nom_complet, famille_user_id)`)
      .single();

    if (updateError) throw updateError;

    // --- NOTIFICATION FIN DE VISITE ---
    if (visiteUpdate.patient && visiteUpdate.patient.famille_user_id) {
      sendPushNotification(
        visiteUpdate.patient.famille_user_id,
        "📸 Nouveau rapport disponible",
        `L'intervention pour ${visiteUpdate.patient.nom_complet} est terminée. État : ${humeur}.`,
        "/#feed",
      );
    }

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ 3. VALIDER UNE VISITE
 * Déclenche : 1 Push "Bilan validé"
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
        "✅ Bilan de soins validé",
        `Le rapport pour ${visite.patient.nom_complet} a été vérifié par nos services.`,
        "/#feed",
      );
    }

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📂 4. LIRE LES VISITES
 * Sécurité : Filtrage automatique selon qui demande les données
 */
router.get(
  "/",
  middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
  async (req, res) => {
    // Jointure pour récupérer les noms sans faire 3 requêtes (Gain de vitesse)
    let query = supabase.from("visites").select(`
        *,
        patient:patients (nom_complet, adresse),
        aidant:aidant_id (nom)
    `);

    if (req.user.role === "AIDANT") {
      query = query.eq("aidant_id", req.user.userId);
    } else if (req.user.role === "FAMILLE") {
      // On récupère d'abord l'ID du patient lié à cette famille
      const { data: patientData } = await supabase
        .from("patients")
        .select("id")
        .eq("famille_user_id", req.user.userId)
        .maybeSingle();

      if (!patientData) return res.json([]);
      query = query
        .eq("patient_id", patientData.id)
        .eq("statut_validation", "Validé");
      // La famille ne voit QUE ce qui est validé par le coordinateur (Sécurité émotionnelle)
    }

    const { data, error } = await query.order("heure_debut", {
      ascending: false,
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  },
);

module.exports = router;
