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
        // 🛡️ VÉRIFICATION : L'aidant est-il bien assigné à ce patient ?
        const { data: planning, error: planningErr } = await supabase
            .from("planning")
            .select("id, date_prevue")
            .eq("patient_id", patient_id)
            .eq("aidant_id", req.user.userId)
            .maybeSingle();

        if (planningErr || !planning) {
            return res.status(403).json({ 
                error: "Vous n'êtes pas autorisé à intervenir sur ce dossier" 
            });
        }

        // Vérifier si une visite est déjà en cours pour ce patient
        const { data: existingVisit, error: existingErr } = await supabase
            .from("visites")
            .select("id, statut")
            .eq("patient_id", patient_id)
            .eq("aidant_id", req.user.userId)
            .in("statut", ["En cours", "En attente"])
            .maybeSingle();

        if (existingErr) throw existingErr;

        if (existingVisit) {
            return res.status(400).json({ 
                error: "Une visite est déjà en cours ou en attente de validation pour ce patient" 
            });
        }

        // Démarrer la visite
        const { data: visite, error } = await supabase
            .from("visites")
            .insert([{
                patient_id,
                aidant_id: req.user.userId,
                planning_id: planning.id, // Lier au planning
                heure_debut: new Date(),
                gps_start: gps_start,
                statut: "En cours",
            }])
            .select(`*, patient:patients(nom_complet, famille_user_id)`)
            .single();

        if (error) throw error;

        // Mettre à jour le planning si besoin
        if (planning.id) {
            await supabase
                .from("planning")
                .update({ statut: "En cours" })
                .eq("id", planning.id);
        }

        // Notification à la famille
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
        console.error("❌ Crash Route Start:", err.message);
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
    const { visite_id, lat, lng, accuracy } = req.body;
    
    try {
        // 1. Enregistrer la position
        await supabase.from("positions_live").insert([{
            visite_id,
            aidant_id: req.user.userId,
            lat, 
            lng,
            accuracy: accuracy || 0,
            created_at: new Date()
        }]);

        // 2. Récupérer les infos de la visite et du patient
        const { data: visite, error: visitError } = await supabase
            .from("visites")
            .select(`
                id, 
                patient_id, 
                alerte_geofence,
                notifie_arrivee,
                patient:patients(id, lat, lng, rayon_geofence, nom_complet, famille_user_id),
                aidant:profiles!aidant_id(id, nom, photo_url)
            `)
            .eq("id", visite_id)
            .single();

        if (visitError || !visite) {
            console.error("❌ Visite non trouvée:", visitError);
            return res.sendStatus(200);
        }

        // 3. Vérifier la géolocalisation par rapport au domicile du patient
        if (visite.patient && visite.patient.lat) {
            const distance = getDistance(lat, lng, visite.patient.lat, visite.patient.lng);
            const rayonAutorise = visite.patient.rayon_geofence || 100;
            const isInside = distance <= rayonAutorise;

            // Mettre à jour l'alerte geofence
            if (distance > rayonAutorise && !visite.alerte_geofence) {
                await supabase
                    .from("visites")
                    .update({ 
                        alerte_geofence: true,
                        distance_max_constatee: distance 
                    })
                    .eq("id", visite_id);
            } else if (distance <= rayonAutorise && visite.alerte_geofence) {
                await supabase
                    .from("visites")
                    .update({ alerte_geofence: false })
                    .eq("id", visite_id);
            }

            // 4. 🔔 NOTIFICATION D'ARRIVÉE (quand l'aidant entre dans le périmètre)
            const alreadyNotified = visite.notifie_arrivee;
            const seuilNotification = 50; // 50 mètres pour déclencher la notification
            
            if (distance <= seuilNotification && !alreadyNotified && visite.patient.famille_user_id) {
                // Marquer comme notifié
                await supabase
                    .from("visites")
                    .update({ notifie_arrivee: true })
                    .eq("id", visite_id);
                
                // Envoyer la notification push à la famille
                const message = `🩺 ${visite.aidant?.nom || "L'aidant"} est arrivé${distance < 20 ? ' devant le domicile' : ' dans le quartier'} de ${visite.patient.nom_complet}.`;
                
                await sendPushNotification(
                    visite.patient.famille_user_id,
                    "🚪 L'aidant arrive",
                    message,
                    "/#feed"
                );
                
                // Ajouter un message automatique dans le feed
                await supabase.from("messages").insert([{
                    patient_id: visite.patient_id,
                    sender_id: req.user.userId,
                    content: `📍 ${visite.aidant?.nom} est arrivé${distance < 20 ? ' au domicile' : ' dans le périmètre'} pour la visite.`,
                    is_photo: false,
                    type_media: 'STORY'
                }]);
                
                console.log(`📢 Notification d'arrivée envoyée pour la visite ${visite_id}`);
            }
            
            // 5. 🔔 NOTIFICATION DE DÉPART (quand l'aidant quitte le périmètre après être entré)
            const wasNotified = visite.notifie_arrivee;
            const quittePerimetre = distance > rayonAutorise * 1.5; // 1.5x le rayon
            
            if (wasNotified && quittePerimetre && visite.patient.famille_user_id) {
                // Ne pas renvoyer trop souvent (cooldown de 30 minutes)
                const lastLeaveKey = `last_leave_${visite_id}`;
                const lastLeave = await supabase
                    .from("visite_events")
                    .select("created_at")
                    .eq("visite_id", visite_id)
                    .eq("event_type", "leave")
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();
                
                let shouldNotify = true;
                if (lastLeave?.created_at) {
                    const timeSinceLastLeave = Date.now() - new Date(lastLeave.created_at).getTime();
                    if (timeSinceLastLeave < 30 * 60 * 1000) { // 30 minutes
                        shouldNotify = false;
                    }
                }
                
                if (shouldNotify) {
                    await supabase.from("visite_events").insert([{
                        visite_id,
                        event_type: "leave",
                        distance: distance
                    }]);
                    
                    await sendPushNotification(
                        visite.patient.famille_user_id,
                        "👋 Fin de visite",
                        `${visite.aidant?.nom} a quitté le domicile de ${visite.patient.nom_complet}.`,
                        "/#feed"
                    );
                }
            }
        }
        
        res.sendStatus(200);
        
    } catch (err) { 
        console.error("❌ Erreur tracking:", err.message);
        res.sendStatus(500); 
    }
});

/**
 * 📏 Calculer la distance entre deux points GPS (formule de Haversine)
 * Retourne la distance en mètres
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Rayon de la Terre en mètres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance en mètres
}
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




/**
 * 🏠 POSITION ACTIVE POUR LA FAMILLE
 * Récupère la dernière position connue d'une visite en cours pour un patient donné
 */
router.get("/active/:patientId", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { patientId } = req.params;

    // 🔒 Vérification que la famille a bien accès à ce patient
    if (req.user.role === "FAMILLE") {
        const { data: patient, error } = await supabase
            .from("patients")
            .select("id")
            .eq("id", patientId)
            .eq("famille_user_id", req.user.userId)
            .single();

        if (error || !patient) {
            return res.status(403).json({ error: "Accès non autorisé à ce dossier" });
        }
    }

    try {
        // 1. Trouver la visite en cours pour ce patient
        const { data: visite, error: visiteError } = await supabase
            .from("visites")
            .select("id, aidant_id, alerte_geofence")
            .eq("patient_id", patientId)
            .eq("statut", "En cours")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (visiteError || !visite) {
            return res.json({}); // Pas de visite en cours
        }

        // 2. Récupérer la dernière position connue
        const { data: lastPos, error: posError } = await supabase
            .from("positions_live")
            .select("lat, lng, created_at")
            .eq("visite_id", visite.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (posError || !lastPos) {
            return res.json({}); 
        }

        // 3. Récupérer le nom de l'aidant
        const { data: aidant, error: aidantError } = await supabase
            .from("profiles")
            .select("nom")
            .eq("id", visite.aidant_id)
            .single();

        res.json({
            lat: lastPos.lat,
            lng: lastPos.lng,
            aidant_nom: aidant?.nom || "Intervenant",
            is_inside: !visite.alerte_geofence,
            last_update: lastPos.created_at
        });

    } catch (err) {
        console.error("❌ Erreur route /active/:patientId:", err.message);
        res.status(500).json({ error: err.message });
    }
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

/**
 * 📍 POSITION EN DIRECT POUR LA FAMILLE
 */
router.get("/live-position/:visite_id", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { visite_id } = req.params;
    
    try {
        // Vérifier que la famille a accès à cette visite
        if (req.user.role === "FAMILLE") {
            const { data: visite } = await supabase
                .from("visites")
                .select("patient:patients(famille_user_id)")
                .eq("id", visite_id)
                .single();
            
            if (!visite?.patient || visite.patient.famille_user_id !== req.user.userId) {
                return res.status(403).json({ error: "Accès non autorisé" });
            }
        }
        
        // Récupérer la dernière position
        const { data: lastPos } = await supabase
            .from("positions_live")
            .select("lat, lng, created_at")
            .eq("visite_id", visite_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        
        if (!lastPos) {
            return res.json({ hasPosition: false });
        }
        
        // Récupérer les infos de l'aidant
        const { data: visite } = await supabase
            .from("visites")
            .select("aidant:profiles!aidant_id(nom, photo_url)")
            .eq("id", visite_id)
            .single();
        
        res.json({
            hasPosition: true,
            lat: lastPos.lat,
            lng: lastPos.lng,
            last_update: lastPos.created_at,
            aidant_nom: visite?.aidant?.nom || "Intervenant",
            aidant_photo: visite?.aidant?.photo_url || null
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
