const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware"); // On utilise le middleware complet

router.get("/", middleware(["COORDINATEUR", "FAMILLE", "AIDANT"]), async (req, res) => {
  try {
    console.log(`🔍 [PATIENTS] Chargement pour : ${req.user.role}`);

    // Requête de base
    let query = supabase.from("patients").select(`
        *,
        famille:famille_user_id (nom, email, telephone)
    `);

    // 🛡️ FILTRAGE PAR RÔLE
    if (req.user.role === "FAMILLE") {
      // Une famille ne voit que son propre dossier
      query = query.eq("famille_user_id", req.user.userId);
    } 
    else if (req.user.role === "AIDANT") {
      // Un aidant ne voit que les patients qui sont dans son planning
      const { data: planning } = await supabase
        .from("planning")
        .select("patient_id")
        .eq("aidant_id", req.user.userId);
      
      const patientIds = planning ? planning.map(p => p.patient_id) : [];
      query = query.in("id", patientIds);
    }

    const { data, error } = await query.order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);

  } catch (err) {
    console.error("❌ Erreur Route Patients:", err.message);
    res.status(500).json({ error: err.message });
  }
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



/**
 * 💳 METTRE À JOUR LE PACK D'UN PATIENT
 */
router.put("/:id/update-pack", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { id } = req.params;
    const { type_pack, montant_prevu } = req.body;
    
    // Vérification que la famille a accès à ce patient
    if (req.user.role === "FAMILLE") {
        const { data: patient } = await supabase
            .from("patients")
            .select("famille_user_id")
            .eq("id", id)
            .single();
        
        if (!patient || patient.famille_user_id !== req.user.userId) {
            return res.status(403).json({ error: "Accès non autorisé" });
        }
    }
    
    const { error } = await supabase
        .from("patients")
        .update({ type_pack, montant_prevu })
        .eq("id", id);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
});


/**
 * 📸 Mettre à jour la photo du patient
 */
router.post("/update-photo", middleware(["FAMILLE", "COORDINATEUR"]), upload.single('photo'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Aucune photo" });
        
        // Récupérer le patient de la famille
        let patientId = req.body.patient_id;
        
        if (req.user.role === "FAMILLE" && !patientId) {
            const { data: patient } = await supabase
                .from("patients")
                .select("id")
                .eq("famille_user_id", req.user.userId)
                .single();
            patientId = patient?.id;
        }
        
        if (!patientId) return res.status(404).json({ error: "Patient non trouvé" });
        
        const fileName = `patients/${patientId}_${Date.now()}.jpg`;
        await supabase.storage.from("photos").upload(fileName, file.buffer, {
            contentType: 'image/jpeg',
            upsert: true
        });
        
        const { data: urlData } = supabase.storage.from("photos").getPublicUrl(fileName);
        const photo_url = urlData.publicUrl;
        
        await supabase.from("patients").update({ photo_url }).eq("id", patientId);
        
        res.json({ photo_url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
