const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");

/**
 * 💊 1. CRÉER UNE COMMANDE (Famille ou Coordinateur)
 * ⚠️ L'AIDANT ne peut PAS créer de commande (seulement livrer)
 */
router.post("/add", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
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
        // 🛡️ Vérifier que l'aidant assigné existe et a le bon rôle
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

        // 🔔 NOTIFICATION : On prévient la famille que le prix est fixé
        if (cmd.patient && cmd.patient.famille_user_id) {
            sendPushNotification(
                cmd.patient.famille_user_id,
                "💊 Pharmacie : Prix validé",
                `Le montant pour les médicaments de ${cmd.patient.nom_complet} est de ${prix_total} CFA.`,
                "/#billing"
            );
        }
        
        // 🔔 NOTIFICATION : On prévient l'aidant qu'il a une livraison à faire
        sendPushNotification(
            aidant_id,
            "📦 Nouvelle livraison",
            `Vous avez une commande à livrer pour ${cmd.patient.nom_complet}.`,
            "/#commandes"
        );

        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📦 3. FINALISER LA LIVRAISON (Aidant)
 * 🛡️ Vérification que l'aidant est bien assigné à cette commande
 */
router.post("/deliver", middleware(["AIDANT"]), async (req, res) => {
    const { commande_id, photo_url } = req.body;

    try {
        // 🛡️ Vérifier que l'aidant est bien assigné à cette commande
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

        // A. On marque la commande comme livrée
        const { data: cmd, error: errCmd } = await supabase
            .from("commandes_meds")
            .update({
                photo_livraison: photo_url,
                statut: "Livrée",
                date_livraison: new Date()
            })
            .eq("id", commande_id)
            .select('patient_id, patient:patients(nom_complet, famille_user_id)')
            .single();

        if (errCmd) throw errCmd;

        // B. On injecte le reçu dans le feed (Documents)
        await supabase.from("messages").insert([{
            patient_id: cmd.patient_id,
            sender_id: req.user.userId,
            content: photo_url,
            is_photo: true,
            type_media: 'DOCUMENT',
            titre_media: `Reçu Pharmacie - ${cmd.patient.nom_complet}`
        }]);

        // C. Notification à la famille
        if (cmd.patient && cmd.patient.famille_user_id) {
            sendPushNotification(
                cmd.patient.famille_user_id,
                "📦 Médicaments livrés",
                `Les médicaments pour ${cmd.patient.nom_complet} ont été livrés.`,
                "/#feed"
            );
        }

        console.log(`✅ [LOGISTIQUE] Livraison confirmée et reçu archivé pour la commande ${commande_id}`);
        res.json({ status: "success" });

    } catch (err) {
        console.error("❌ Erreur livraison:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📋 4. LISTER LES COMMANDES (Filtrage de sécurité par rôle)
 */
router.get("/", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        let query = supabase.from("commandes_meds").select(`
            *,
            patient:patients (id, nom_complet, adresse, famille_user_id),
            demandeur:profiles!commandes_meds_demandeur_id_fkey (nom),
            aidant:profiles!commandes_meds_aidant_id_fkey (nom)
        `);

        // 🛡️ FILTRES DE SÉCURITÉ PAR RÔLE
        if (req.user.role === "AIDANT") {
            // L'aidant ne voit que les commandes qui lui sont assignées
            query = query.eq("aidant_id", req.user.userId);
        } 
        else if (req.user.role === "FAMILLE") {
            // La famille ne voit que les commandes de SON patient
            const { data: patients, error } = await supabase
                .from("patients")
                .select("id")
                .eq("famille_user_id", req.user.userId);
            
            if (error || !patients || patients.length === 0) {
                return res.json([]);
            }
            
            const patientIds = patients.map(p => p.id);
            query = query.in("patient_id", patientIds);
        }
        // COORDINATEUR voit tout (pas de filtre)

        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;
        res.json(data);

    } catch (err) {
        console.error("❌ Erreur liste commandes:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
