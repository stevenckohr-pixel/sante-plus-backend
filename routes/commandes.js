const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });


const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
        fieldSize: 10 * 1024 * 1024  // 10MB
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

 
/**
 * 💰 2. CONFIRMER LE PRIX & ASSIGNER (Coordinateur)
 */
router.post("/confirm", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commande_id, aidant_id, prix_total } = req.body;
    
    try {
        // Vérifier que l'aidant existe et a le bon rôle
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();
        
        if (aidantErr || !aidant) {
            return res.status(400).json({ error: "Aidant invalide" });
        }
        
        const { data: cmd, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id,
                prix_total,
                statut: "Confirmée",
            })
            .eq("id", commande_id)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();

        if (error) throw error;

        // Notification à la famille
        if (cmd.patient && cmd.patient.famille_user_id) {
            sendPushNotification(
                cmd.patient.famille_user_id,
                "💊 Pharmacie : Prix validé",
                `Le montant pour les médicaments de ${cmd.patient.nom_complet} est de ${prix_total} CFA.`,
                "/#billing"
            );
        }
        
        // Notification à l'aidant
        sendPushNotification(
            aidant_id,
            "📦 Nouvelle livraison",
            `Vous avez une commande à livrer pour ${cmd.patient.nom_complet}.`,
            "/#commandes"
        );

        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur confirmation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📦 3. FINALISER LA LIVRAISON (Aidant)
 */
router.post("/deliver", middleware(["AIDANT"]), upload.single('photo_livraison'), async (req, res) => {
    console.log("🔵 [DELIVER] Début de la requête");
    console.log("🔵 Body:", req.body);
    console.log("🔵 Fichier:", req.file ? `Reçu (${req.file.size} bytes)` : "Aucun fichier");
    const { commande_id } = req.body;
    const photoFile = req.file;  

    console.log("📦 Requête reçue:", { commande_id, hasFile: !!photoFile });

    if (!photoFile) {
        return res.status(400).json({ error: "Photo obligatoire" });
    }

    try {
        // Vérifier la commande
        const { data: commande, error: checkErr } = await supabase
            .from("commandes_meds")
            .select("id, aidant_id, patient_id")
            .eq("id", commande_id)
            .single();
        
        if (checkErr || !commande) {
            return res.status(404).json({ error: "Commande introuvable" });
        }
        
        if (commande.aidant_id !== req.user.userId) {
            return res.status(403).json({ error: "Vous n'êtes pas assigné à cette commande" });
        }

        // Upload photo
        const fileName = `commandes/${commande_id}_${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
            .from("preuves")
            .upload(fileName, photoFile.buffer, {
                contentType: 'image/jpeg',
                upsert: true
            });
        
        if (uploadError) throw uploadError;
        
        const { data: urlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
        const photoUrl = urlData.publicUrl;

        // Mettre à jour la commande
        const { error: updateError } = await supabase
            .from("commandes_meds")
            .update({
                photo_livraison: photoUrl,
                statut: "Livrée",
                date_livraison: new Date()
            })
            .eq("id", commande_id);
        
        if (updateError) throw updateError;

        // Récupérer les infos pour notification
        const { data: patient } = await supabase
            .from("patients")
            .select("nom_complet, famille_user_id")
            .eq("id", commande.patient_id)
            .single();

        // Ajouter dans le feed
        await supabase.from("messages").insert([{
            patient_id: commande.patient_id,
            sender_id: req.user.userId,
            content: photoUrl,
            is_photo: true,
            type_media: 'DOCUMENT',
            titre_media: `Reçu Pharmacie - ${patient.nom_complet}`
        }]);

        // Notification à la famille
        if (patient.famille_user_id) {
            await sendPushNotification(
                patient.famille_user_id,
                "📦 Médicaments livrés",
                `Les médicaments pour ${patient.nom_complet} ont été livrés.`,
                "/#feed"
            );
        }

        console.log("✅ Livraison confirmée pour commande:", commande_id);
        res.json({ status: "success" });

    } catch (err) {
        console.error("❌ Erreur livraison:", err);
        res.status(500).json({ error: err.message });
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
            demandeur:profiles!commandes_meds_demandeur_id_fkey (nom),
            aidant:profiles!commandes_meds_aidant_id_fkey (nom, telephone)
        `);

        if (req.user.role === "AIDANT") {
            // ✅ Aidant voit les commandes assignées ET en attente de livraison
            query = query
                .eq("aidant_id", req.user.userId)
                .in("statut", ["Confirmée", "Livrée"]);
        } 
        else if (req.user.role === "FAMILLE") {
            // ✅ Famille voit TOUTES ses commandes
            const { data: patients } = await supabase
                .from("patients")
                .select("id")
                .eq("famille_user_id", req.user.userId);
            
            if (!patients || patients.length === 0) {
                return res.json([]);
            }
            
            const patientIds = patients.map(p => p.id);
            query = query.in("patient_id", patientIds);
        }
        // COORDINATEUR voit tout

        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error("❌ Erreur liste commandes:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
