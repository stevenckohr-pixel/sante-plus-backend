const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware"); // On utilise le middleware complet

// LISTER LES PATIENTS (Corrigé pour joindre les infos de la famille)
router.get("/", middleware(["COORDINATEUR", "FAMILLE", "AIDANT"]), async (req, res) => {
  // On joint le nom de la famille et du coordinateur pour un affichage complet
let query = supabase.from("visites").select("*");


  // Si c'est un compte Famille, il ne voit que son proche
  if (req.user.role === "FAMILLE") {
    query = query.eq("famille_user_id", req.user.userId);
  }

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// AJOUTER UN NOUVEAU PATIENT (Coordinateur)
router.post("/add", middleware(["COORDINATEUR"]), async (req, res) => {
  const { nom_complet, adresse, formule } = req.body;

  const { data, error } = await supabase.from("patients").insert([
    {
      nom_complet,
      adresse,
      formule,
      coordinateur_id: req.user.userId,
    },
  ]);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "success" });
});

// 💥 NOUVEAU : LIER UN COMPTE FAMILLE À UN DOSSIER PATIENT (Coordinateur)
router.post("/link-family", middleware(["COORDINATEUR"]), async (req, res) => {
  const { patient_id, famille_user_id } = req.body;

  const { error } = await supabase
    .from("patients")
    .update({ famille_user_id: famille_user_id })
    .eq("id", patient_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "success" });
});



/**
 * 🔍 RÉCUPÉRER UN SEUL PATIENT (Détails complets)
 */
router.get("/:id", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("patients")
            .select(`
                *,
                famille:famille_user_id (nom, email, telephone)
            `)
            .eq("id", req.params.id)
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(404).json({ error: "Dossier introuvable" });
    }
});


/**
 * 📍 FIXER LES COORDONNÉES GPS DU DOMICILE
 * Autorisé pour le Coordinateur et l'Aidant (lorsqu'il est sur place)
 */
router.post("/update-gps", middleware(['COORDINATEUR', 'AIDANT']), async (req, res) => {
    const { patient_id, lat, lng } = req.body;

    try {
        console.log(`🏠 [GPS] Fixation du domicile pour le patient ${patient_id} : ${lat}, ${lng}`);

        const { error } = await supabase
            .from("patients")
            .update({ 
                lat: lat, 
                lng: lng,
                rayon_geofence: 100 // On définit un rayon de 100m par défaut
            })
            .eq("id", patient_id);

        if (error) throw error;

        res.json({ status: "success", message: "Coordonnées du domicile enregistrées." });
    } catch (err) {
        console.error("❌ Erreur Update GPS Patient:", err.message);
        res.status(500).json({ error: "Impossible d'enregistrer la position." });
    }
});

module.exports = router;
