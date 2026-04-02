const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");

/**
 * 📋 1. LISTER LES ASSIGNATIONS
 * - Coordinateur : voit tout
 * - Aidant : voit ses propres assignations actives
 */
router.get("/", middleware(["COORDINATEUR", "AIDANT"]), async (req, res) => {
    try {
        let query = supabase
            .from("planning")
            .select(`
                id,
                patient_id,
                aidant_id,
                date_prevue,
                heure_prevue,
                statut,
                notes_coordinateur,
                est_actif,
                date_fin,
                raison_desactivation,
                patient:patients(id, nom_complet, adresse, formule),
                aidant:profiles!aidant_id(id, nom, email, telephone)
            `)
            .eq("est_actif", true);

        // Filtrer pour l'aidant
        if (req.user.role === "AIDANT") {
            query = query.eq("aidant_id", req.user.userId);
        }

        const { data, error } = await query.order("created_at", { ascending: false });

        if (error) throw error;
        res.json(data || []);

    } catch (err) {
        console.error("❌ Erreur liste assignations:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * ➕ 2. ASSIGNER UN PATIENT À UN AIDANT (Coordinateur uniquement)
 */
router.post("/assign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { patient_id, aidant_id, date_prevue, heure_prevue, notes } = req.body;

    if (!patient_id || !aidant_id) {
        return res.status(400).json({ error: "Patient et aidant requis" });
    }

    try {
        // Vérifier que le patient existe
        const { data: patient, error: patientErr } = await supabase
            .from("patients")
            .select("id, nom_complet, famille_user_id")
            .eq("id", patient_id)
            .single();

        if (patientErr || !patient) {
            return res.status(404).json({ error: "Patient introuvable" });
        }

        // Vérifier que l'aidant existe et a le bon rôle
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();

        if (aidantErr || !aidant) {
            return res.status(404).json({ error: "Aidant introuvable ou rôle incorrect" });
        }

        // Vérifier si une assignation active existe déjà
        const { data: existing, error: existingErr } = await supabase
            .from("planning")
            .select("id")
            .eq("patient_id", patient_id)
            .eq("aidant_id", aidant_id)
            .eq("est_actif", true)
            .maybeSingle();

        if (existing) {
            return res.status(400).json({ error: "Ce patient est déjà assigné à cet aidant" });
        }

        // Créer l'assignation
        const { data: newAssignment, error } = await supabase
            .from("planning")
            .insert([{
                patient_id,
                aidant_id,
                date_prevue: date_prevue || new Date().toISOString().split('T')[0],
                heure_prevue: heure_prevue || "09:00",
                notes_coordinateur: notes || "",
                statut: "Planifié",
                est_actif: true
            }])
            .select()
            .single();

        if (error) throw error;

        // 🔔 Notifier l'aidant
        sendPushNotification(
            aidant_id,
            "📋 Nouvelle assignation",
            `Vous avez été assigné au patient ${patient.nom_complet}.`,
            "/#planning"
        );

        // 🔔 Notifier la famille (optionnel)
        if (patient.famille_user_id) {
            sendPushNotification(
                patient.famille_user_id,
                "👨‍⚕️ Nouvel intervenant",
                `${aidant.nom} a été assigné à votre proche ${patient.nom_complet}.`,
                "/#patients"
            );
        }

        res.json({ 
            status: "success", 
            message: `Patient assigné à ${aidant.nom}`,
            assignment: newAssignment
        });

    } catch (err) {
        console.error("❌ Erreur assignation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * ❌ 3. DÉLIER UN PATIENT D'UN AIDANT (Coordinateur uniquement)
 */
router.post("/unassign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { assignment_id, raison } = req.body;

    if (!assignment_id) {
        return res.status(400).json({ error: "ID d'assignation requis" });
    }

    try {
        // Récupérer l'assignation avant suppression
        const { data: assignment, error: fetchErr } = await supabase
            .from("planning")
            .select(`
                id,
                patient_id,
                aidant_id,
                patient:patients(id, nom_complet, famille_user_id),
                aidant:profiles!aidant_id(id, nom)
            `)
            .eq("id", assignment_id)
            .single();

        if (fetchErr || !assignment) {
            return res.status(404).json({ error: "Assignation introuvable" });
        }

        // Désactiver l'assignation (soft delete)
        const { error: updateErr } = await supabase
            .from("planning")
            .update({
                est_actif: false,
                date_fin: new Date().toISOString().split('T')[0],
                raison_desactivation: raison || "Désassigné par le coordinateur"
            })
            .eq("id", assignment_id);

        if (updateErr) throw updateErr;

        // 🔔 Notifier l'aidant
        sendPushNotification(
            assignment.aidant_id,
            "❌ Fin d'assignation",
            `Vous n'êtes plus assigné au patient ${assignment.patient.nom_complet}. ${raison ? `Raison: ${raison}` : ''}`,
            "/#planning"
        );

        // 🔔 Notifier la famille
        if (assignment.patient.famille_user_id) {
            sendPushNotification(
                assignment.patient.famille_user_id,
                "👨‍⚕️ Changement d'intervenant",
                `${assignment.aidant.nom} n'est plus assigné à votre proche.`,
                "/#patients"
            );
        }

        res.json({ 
            status: "success", 
            message: `Patient délié de ${assignment.aidant.nom}` 
        });

    } catch (err) {
        console.error("❌ Erreur désassignation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 👥 4. LISTER LES AIDANTS DISPONIBLES (Pour assignation)
 */
router.get("/available-aidants", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const { data: aidants, error } = await supabase
            .from("profiles")
            .select("id, nom, email, telephone")
            .eq("role", "AIDANT")
            .eq("statut_validation", "ACTIF")
            .order("nom");

        if (error) throw error;
        res.json(aidants || []);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 👤 5. LISTER LES PATIENTS NON ASSIGNÉS (Pour assignation)
 */
router.get("/unassigned-patients", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        // Récupérer les IDs des patients déjà assignés activement
        const { data: assigned } = await supabase
            .from("planning")
            .select("patient_id")
            .eq("est_actif", true);

        const assignedIds = assigned ? assigned.map(a => a.patient_id) : [];

        let query = supabase
            .from("patients")
            .select("id, nom_complet, adresse, formule")
            .eq("statut_validation", "ACTIF");

        if (assignedIds.length > 0) {
            query = query.not("id", "in", `(${assignedIds.join(",")})`);
        }

        const { data: patients, error } = await query.order("nom_complet");

        if (error) throw error;
        res.json(patients || []);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
