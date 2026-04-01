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
        statut: "En cours",  
      }])
      .select(`*, patient:patients(nom_complet, famille_user_id)`)  
      .single();

    if (error) throw error;

    if (visite.patient && visite.patient.famille_user_id) {
        sendPushNotification(
            visite.patient.famille_user_id,
            "🔔 SPS : Début d'intervention",
            `L'intervenant vient d'arriver au domicile de ${visite.patient.nom_complet}.`,
            "/#feed"
        );
    }

    res.json({ status: "success", visite_id: visite.id });
  } catch (err) {
    console.error("Crash Route Start:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ⏹️ 2. TERMINER UNE VISITE (AVEC AUTO-FEED)
 */
router.post("/end", middleware(["AIDANT"]), async (req, res) => {
  const { visite_id, activites_faites, notes, gps_end, humeur } = req.body;
  const photoFile = req.files ? req.files.find((f) => f.fieldname === "photo_visite") : null;

  if (!photoFile) return res.status(400).json({ error: "Photo obligatoire." });

  try {
    // 1. Upload de la photo de preuve
    const fileName = `visites/${visite_id}_${Date.now()}.jpg`;
    await supabase.storage.from("preuves").upload(fileName, photoFile.buffer, { 
        contentType: 'image/jpeg', 
        upsert: true 
    });
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
        statut: "En attente",  
      })
      .eq("id", visite_id)
      .select(`*, patient:patients(nom_complet, famille_user_id)`)
      .single();

    if (updateError) throw updateError;

    // A. Insertion de la PHOTO dans le feed
    await supabase.from("messages").insert([{
        patient_id: v.patient_id,
        sender_id: req.user.userId,
        content: photoUrl,
        is_photo: true
    }]);

    // B. Insertion du RÉSUMÉ dans le feed
    await supabase.from("messages").insert([{
        patient_id: v.patient_id,
        sender_id: req.user.userId,
        content: `${humeur}|${notes}`,
        is_photo: false
    }]);

    if (v.patient && v.patient.famille_user_id) {
        sendPushNotification(
            v.patient.famille_user_id,
            "📸 SPS : Rapport de visite disponible",
            `L'intervention pour ${v.patient.nom_complet} est terminée. Consultez le journal.`,
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
 * ✅ 3. VALIDER UNE VISITE (Coordinateur)
 */
router.post("/validate", middleware(["COORDINATEUR"]), async (req, res) => {
  const { visite_id, statut } = req.body;

  try {
    const { data: visite, error } = await supabase
        .from("visites")
        .update({ statut: statut })  
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
 * 📂 4. LIRE LES VISITES (Filtrage)
 */
router.get("/", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        let query = supabase.from("visites").select(`
            *,
            patient:patient_id (nom_complet, adresse),
            aidant:aidant_id (nom)
        `);

        if (req.user.role === "AIDANT") {
            query = query.eq("aidant_id", req.user.userId);
        } else if (req.user.role === "FAMILLE") {
            const { data: p } = await supabase.from("patients")
                .select("id")
                .eq("famille_user_id", req.user.userId)
                .maybeSingle();
            
            if (!p) return res.json([]);
            query = query.eq("patient_id", p.id).eq("statut", "Validé"); 
        }

        const { data, error } = await query.order("heure_debut", { ascending: false });
        if (error) throw error;
        res.json(data || []);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 🛰️ TRACKING GPS (Appelé par le mobile)
 */
router.post("/track", middleware(['AIDANT']), async (req, res) => {
    const { visite_id, lat, lng } = req.body;
    try {
        await supabase.from("positions_live").insert([{
            visite_id,
            aidant_id: req.user.userId,
            lat, lng
        }]);

        const { data: visite } = await supabase
            .from("visites")
            .select(`id, patient_id, patient:patients(lat, lng, rayon_geofence)`)
            .eq("id", visite_id)
            .single();

        if (visite && visite.patient.lat) {
            const distance = getDistance(lat, lng, visite.patient.lat, visite.patient.lng);
            const rayonAutorise = visite.patient.rayon_geofence || 100;

            if (distance > rayonAutorise) {
                await supabase.from("visites").update({ 
                    alerte_geofence: true,
                    distance_max_constatee: distance 
                }).eq("id", visite_id);
            }
        }
        res.sendStatus(200);
    } catch (err) { res.sendStatus(500); }
});

/**
 * 📡 RADAR LIVE (Pour Coordinateur)
 */
router.get("/live-tracking", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        const { data: activeVisits } = await supabase
            .from("visites")
            .select(`id, aidant_id, alerte_geofence, patient:patients(nom_complet, lat, lng), aidant:profiles!aidant_id(nom)`)
            .eq("statut", "En cours"); 

        if (!activeVisits) return res.json([]);

        const liveData = await Promise.all(activeVisits.map(async (v) => {
            const { data: lastPos } = await supabase
                .from("positions_live")
                .select("lat, lng")
                .eq("visite_id", v.id)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!lastPos) return null;
            return {
                visite_id: v.id,
                lat: lastPos.lat,
                lng: lastPos.lng,
                aidant_nom: v.aidant.nom,
                patient_nom: v.patient.nom_complet,
                is_inside: !v.alerte_geofence
            };
        }));
        res.json(liveData.filter(d => d !== null));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/trajectory/:visite_id", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("positions_live")
            .select("lat, lng, created_at")
            .eq("visite_id", req.params.visite_id) 
            .order("created_at", { ascending: true });
        if (error) throw error;
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const p1 = lat1 * Math.PI/180;
    const p2 = lat2 * Math.PI/180;
    const dp = (lat2-lat1) * Math.PI/180;
    const dl = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; 
}

module.exports = router;
