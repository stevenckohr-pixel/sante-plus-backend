const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

/**
 * 💊 1. CRÉER UNE COMMANDE (Famille ou Coordinateur)
 */
router.post("/add", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { patient_id, liste_medocs } = req.body;
    
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
        
        // Logique : On pourrait envoyer un Push au Coordinateur ici
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
        /* 
        sendPushNotification(
            cmd.patient.famille_user_id, 
            "💊 Pharmacie : Prix validé", 
            `Le montant pour les médicaments de ${cmd.patient.nom_complet} est de ${prix_total} CFA.`
        );
        */

        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📦 3. FINALISER LA LIVRAISON (Aidant)
 * C'est ici que la magie opère : Double mise à jour (Commande + Feed)
 */
router.post("/deliver", middleware(["AIDANT"]), async (req, res) => {
    const { commande_id, photo_url } = req.body;

    try {
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

        // B. ⚡ AUTOMATISATION ELITE : On injecte le reçu dans le coffre-fort (Documents) de la famille
        await supabase.from("messages").insert([{
            patient_id: cmd.patient_id,
            sender_id: req.user.userId,
            content: photo_url, // L'URL de la photo de livraison/reçu
            is_photo: true,
            type_media: 'DOCUMENT', // 👈 Pour l'onglet "Pièces Jointes"
            titre_media: `Reçu Pharmacie - ${cmd.patient.nom_complet}`
        }]);

        console.log(`✅ [LOGISTIQUE] Livraison confirmée et reçu archivé pour la commande ${commande_id}`);
        res.json({ status: "success" });

    } catch (err) {
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
            patient:patients (id, nom_complet, adresse),
            demandeur:profiles!commandes_meds_demandeur_id_fkey (nom),
            aidant:profiles!commandes_meds_aidant_id_fkey (nom)
        `);

        // Filtres de sécurité
        if (req.user.role === "AIDANT") {
            query = query.eq("aidant_id", req.user.userId);
        } 
        else if (req.user.role === "FAMILLE") {
            const { data: p } = await supabase.from("patients").select("id").eq("famille_user_id", req.user.userId).single();
            if (p) query = query.eq("patient_id", p.id);
        }

        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;
        res.json(data);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
