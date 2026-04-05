const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");
const multer = require("multer");

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
        fieldSize: 10 * 1024 * 1024, // 10MB
        fields: 10,
        files: 1,
        parts: 20
    },
    // Filtrer les types de fichiers
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Type de fichier non supporté'), false);
        }
    }
});

/**
 * 💊 1. CRÉER UNE COMMANDE (Famille ou Coordinateur)
 */
router.post("/add", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
    const { patient_id, liste_medocs } = req.body;
    
    // 🛡️ VÉRIFICATION pour la FAMILLE : le patient doit lui appartenir
    if (req.user.role === "FAMILLE") {
        const { data: patient, error } = await supabase
            .from("patients")
            .select("id")
            .eq("id", patient_id)
            .eq("famille_user_id", req.user.userId)
            .single();
        
        if (error || !patient) {
            return res.status(403).json({ error: "Vous ne pouvez pas commander pour ce patient" });
        }
    }
    
    try {
        const { error } = await supabase.from("commandes_meds").insert([
            {
                patient_id,
                demandeur_id: req.user.userId,
                liste_medocs,
                statut: "En attente",
            },
        ]);

        if (error) throw error;
        
        // 🔔 Envoyer une notification au coordinateur
        const { data: coordinators } = await supabase
            .from("profiles")
            .select("id")
            .eq("role", "COORDINATEUR");
        
        if (coordinators) {
            coordinators.forEach(coord => {
                sendPushNotification(
                    coord.id,
                    "💊 Nouvelle commande",
                    `Une nouvelle commande de médicaments est en attente.`,
                    "/#commandes"
                );
            });
        }
        
        res.json({ status: "success", message: "Demande de pharmacie enregistrée." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

 router.post("/accept", middleware(["AIDANT"]), async (req, res) => {
    const { commandeId } = req.body;
    
    try {
        const { data: commande, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id: req.user.userId,
                statut: "En cours de livraison"
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();
        
        if (error) throw error;
        
        // Notifier la famille
        if (commande.patient.famille_user_id) {
            sendPushNotification(
                commande.patient.famille_user_id,
                "🚚 Commande en cours",
                `${commande.patient.nom_complet} - Un livreur a pris votre commande en charge.`,
                "/#commandes"
            );
        }
        
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/**
 * 💰 2. CONFIRMER LE PRIX & ASSIGNER (Coordinateur)
 */
router.post("/confirm", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commandeId, aidant_id } = req.body;
    
    try {
        // Vérifier que l'aidant existe
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();
        
        if (aidantErr || !aidant) {
            return res.status(400).json({ error: "Aidant invalide" });
        }
        
        // Assigner l'aidant à la commande (sans prix)
        const { data: cmd, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id,
                statut: "En cours de livraison"  // Nouveau statut
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();

        if (error) throw error;

        // Notification à l'aidant
        sendPushNotification(
            aidant_id,
            "📦 Nouvelle commande à livrer",
            `Une commande pour ${cmd.patient.nom_complet} vous a été assignée.`,
            "/#commandes"
        );

        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur confirmation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📋 ASSIGNER UNE COMMANDE À UN AIDANT (Coordinateur)
 */
router.post("/assign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commandeId, aidant_id, notes } = req.body;
    
    try {
        // Vérifier que l'aidant existe
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();
        
        if (aidantErr || !aidant) {
            return res.status(400).json({ error: "Aidant invalide" });
        }
        
        // Assigner l'aidant à la commande
        const { data: cmd, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id: aidant_id,
                statut: "En cours",
                notes_coordinateur: notes || null
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();

        if (error) throw error;

        // Notification à l'aidant
        sendPushNotification(
            aidant_id,
            "📦 Nouvelle commande à livrer",
            `Une commande pour ${cmd.patient.nom_complet} vous a été assignée.`,
            "/#commandes"
        );

        // Notification à la famille
        if (cmd.patient.famille_user_id) {
            sendPushNotification(
                cmd.patient.famille_user_id,
                "🚚 Commande en cours",
                `Votre commande pour ${cmd.patient.nom_complet} a été prise en charge.`,
                "/#commandes"
            );
        }

        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur assignation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * ✅ VALIDER LA LIVRAISON (Coordinateur)
 */
router.post("/validate", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commandeId } = req.body;
    
    try {
        const { data: commande, error } = await supabase
            .from("commandes_meds")
            .update({
                statut: "Validée"
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();
        
        if (error) throw error;
        
        // Notification à la famille
        if (commande.patient.famille_user_id) {
            sendPushNotification(
                commande.patient.famille_user_id,
                "✅ Livraison validée",
                `La livraison pour ${commande.patient.nom_complet} a été validée par la coordination.`,
                "/#commandes"
            );
        }
        
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/**
 * 📦 3. FINALISER LA LIVRAISON (Aidant)
 */
/**
 * 📦 AIDANT LIVRE LA COMMANDE (avec plusieurs photos)
 */
router.post("/:id/deliver", middleware(["AIDANT"]), upload.array('photos', 5), async (req, res) => {
    console.log("🔵 [DELIVER] Début");
    console.log("🔵 Body:", req.body);
    console.log("🔵 Files:", req.files ? req.files.length : 0);
    
    const commandeId = req.params.id; 
    const { notes_livraison } = req.body;
    const photoFiles = req.files || [];
    
    if (!commandeId) {  // ✅ CORRECTION : utiliser la bonne variable
        return res.status(400).json({ error: "ID commande manquant" });
    }

    if (photoFiles.length === 0) {
        return res.status(400).json({ error: "Au moins une photo obligatoire" });
    }

    // Vérifier la taille de chaque photo
    for (const photo of photoFiles) {
        if (photo.size > 5 * 1024 * 1024) {
            return res.status(400).json({ error: "Une photo dépasse 5MB" });
        }
    }

    try {
        // 1. Vérifier la commande
        console.log("🔍 Vérification commande:", commandeId);
        const { data: commande, error: checkErr } = await supabase
            .from("commandes_meds")
            .select("id, aidant_id, patient_id, statut")
            .eq("id", commandeId)
            .single();
        
        if (checkErr) {
            console.error("❌ Erreur check commande:", checkErr);
            return res.status(404).json({ error: "Commande introuvable" });
        }
        
        if (!commande) {
            return res.status(404).json({ error: "Commande introuvable" });
        }

        if (commande.statut === "Livrée") {
            return res.status(400).json({ error: "Commande déjà livrée" });
        }

        // 2. Upload des photos
        console.log("📤 Upload des photos vers Supabase...");
        const uploadedPhotos = [];
        
        for (let i = 0; i < photoFiles.length; i++) {
            const photo = photoFiles[i];
            const fileName = `livraisons/${commandeId}_${Date.now()}_${i}_${Math.random().toString(36).substring(7)}.jpg`;
            
            const { error: uploadError } = await supabase.storage
                .from("preuves")
                .upload(fileName, photo.buffer, {
                    contentType: photo.mimetype || 'image/jpeg',
                    upsert: false,
                    cacheControl: '3600'
                });
            
            if (uploadError) {
                console.error("❌ Erreur upload:", uploadError);
                if (uploadError.message?.includes("bucket")) {
                    return res.status(500).json({ error: "Bucket 'preuves' non configuré. Contactez l'administrateur." });
                }
                throw new Error("Upload échoué: " + uploadError.message);
            }
            
            const { data: urlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
            uploadedPhotos.push(urlData.publicUrl);
        }
        
        console.log(`📸 ${uploadedPhotos.length} photos uploadées`);

        // 3. Mettre à jour la commande
        console.log("📝 Mise à jour commande...");
        const { error: updateError } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id: req.user.userId,
                statut: "Livrée",
                date_livraison: new Date().toISOString(),
                photos_livraison: uploadedPhotos,
                notes_livraison: notes_livraison || null
            })
            .eq("id", commandeId);
        
        if (updateError) {
            console.error("❌ Erreur update:", updateError);
            throw new Error("Mise à jour échouée: " + updateError.message);
        }

        // 4. Récupérer patient et envoyer notification
        const { data: patient, error: patientErr } = await supabase
            .from("patients")
            .select("nom_complet, famille_user_id")
            .eq("id", commande.patient_id)
            .single();

        if (!patientErr && patient) {
            // Ajouter la première photo au feed
            if (uploadedPhotos.length > 0) {
                await supabase.from("messages").insert([{
                    patient_id: commande.patient_id,
                    sender_id: req.user.userId,
                    content: uploadedPhotos[0],
                    is_photo: true,
                    type_media: 'DOCUMENT',
                    titre_media: `Livraison - ${patient.nom_complet}`
                }]);
            }

            // Notification push à la famille
            if (patient.famille_user_id) {
                try {
                    await sendPushNotification(
                        patient.famille_user_id,
                        "📦 Commande livrée",
                        `Votre commande pour ${patient.nom_complet} a été livrée.`,
                        "/#commandes"
                    );
                } catch (pushErr) {
                    console.warn("⚠️ Push notification échouée:", pushErr.message);
                }
            }
        }

        // 5. Notifier les coordinateurs
        const { data: coordinators } = await supabase
            .from("profiles")
            .select("id")
            .eq("role", "COORDINATEUR");
        
        if (coordinators) {
            coordinators.forEach(coord => {
                sendPushNotification(
                    coord.id,
                    "📦 Livraison effectuée",
                    `${patient?.nom_complet || "Un patient"} - Une livraison a été effectuée.`,
                    "/#commandes"
                );
            });
        }

        console.log("✅ Livraison confirmée pour commande:", commandeId);
        res.json({ 
            status: "success", 
            message: "Livraison confirmée", 
            photos: uploadedPhotos 
        });

    } catch (err) {
        console.error("❌ Erreur livraison:", err);
        res.status(500).json({ 
            error: err.message || "Erreur interne du serveur"
        });
    }
});
/**
 * 📋 4. LISTER LES COMMANDES (Filtrage par rôle)
 */
router.get("/", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        let query = supabase.from("commandes_meds").select(`
            *,
            patient:patients (id, nom_complet, adresse, famille_user_id),
            demandeur:profiles!commandes_meds_demandeur_id_fkey (id, nom, role),
            aidant:profiles!commandes_meds_aidant_id_fkey (id, nom, telephone)
        `);

        if (req.user.role === "AIDANT") {
            // ✅ L'aidant voit TOUTES les commandes de ses patients assignés
            // Récupérer les IDs des patients assignés à l'aidant
            const { data: assignments } = await supabase
                .from("planning")
                .select("patient_id")
                .eq("aidant_id", req.user.userId)
                .eq("est_actif", true);
            
            const patientIds = assignments ? assignments.map(a => a.patient_id) : [];
            
            if (patientIds.length === 0) {
                return res.json([]);
            }
            
            // L'aidant voit toutes les commandes de ses patients (même en attente)
            query = query.in("patient_id", patientIds);
        } 
        else if (req.user.role === "FAMILLE") {
            const { data: patients } = await supabase
                .from("patients")
                .select("id")
                .eq("famille_user_id", req.user.userId);
            
            if (!patients || patients.length === 0) return res.json([]);
            const patientIds = patients.map(p => p.id);
            query = query.in("patient_id", patientIds);
        }

        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/**
 * ✅ COORDINATEUR - VALIDER TOUTES LES LIVRAISONS DU JOUR
 */
router.post("/validate-all", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const { data, error } = await supabase
            .from("commandes_meds")
            .update({ 
                statut: "Validée",
                validee_le: new Date().toISOString(),
                validee_par: req.user.userId
            })
            .eq("statut", "Livrée")
            .gte("date_livraison", `${today}T00:00:00`)
            .lte("date_livraison", `${today}T23:59:59`);
        
        if (error) throw error;
        
        res.json({ status: "success", validees: data?.length || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



/**
 * ⏰ AUTO-ASSIGNATION DES COMMANDES (appelé par cron)
 */
async function autoAssignPendingCommands() {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    
    // Commandes en attente depuis plus de 10min
    const { data: pendingCommands, error: fetchError } = await supabase
        .from("commandes_meds")
        .select("id, patient_id, urgent")
        .eq("statut", "En attente")
        .lt("created_at", tenMinutesAgo);
    
    if (fetchError || !pendingCommands?.length) {
        console.log("📦 Aucune commande à assigner automatiquement");
        return;
    }
    
    console.log(`📦 ${pendingCommands.length} commande(s) à assigner auto`);
    
    for (const cmd of pendingCommands) {
        // Trouver les aidants disponibles pour ce patient
        const { data: availableAidants } = await supabase
            .from("planning")
            .select("aidant_id, aidant:profiles!aidant_id(nom)")
            .eq("patient_id", cmd.patient_id)
            .eq("est_actif", true);
        
        if (availableAidants?.length) {
            const aidantId = availableAidants[0].aidant_id;
            const aidantNom = availableAidants[0].aidant?.nom;
            
            // Assigner automatiquement
            await supabase
                .from("commandes_meds")
                .update({ 
                    aidant_id: aidantId,
                    statut: "En cours",
                    auto_assigned: true,
                    auto_assigned_at: new Date().toISOString()
                })
                .eq("id", cmd.id);
            
            // Notifier l'aidant
            await sendPushNotification(
                aidantId,
                cmd.urgent ? "⚠️ Commande urgente (auto-assignée)" : "📦 Nouvelle commande (auto-assignée)",
                `Une commande ${cmd.urgent ? "urgente " : ""}vous a été automatiquement assignée.`,
                "/#commandes"
            );
            
            console.log(`✅ Commande ${cmd.id} auto-assignée à ${aidantNom}`);
        } else {
            console.log(`⚠️ Aucun aidant disponible pour la commande ${cmd.id}`);
        }
    }
}

// Exposer la fonction pour le cron
module.exports.autoAssignPendingCommands = autoAssignPendingCommands;

router.post("/upload-image", middleware(["FAMILLE", "AIDANT", "COORDINATEUR"]), upload.single('image'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Aucune image" });
        
        const fileName = `commandes/${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
        
        const { error } = await supabase.storage
            .from("commandes")
            .upload(fileName, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });
        
        if (error) throw error;
        
        const { data: urlData } = supabase.storage.from("commandes").getPublicUrl(fileName);
        
        res.json({ url: urlData.publicUrl });
    } catch (err) {
        console.error("❌ Erreur upload image:", err);
        res.status(500).json({ error: err.message });
    }
});




module.exports = router;
