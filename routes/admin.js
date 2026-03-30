const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");

/**
 * ✅ VALIDER UN NOUVEAU MEMBRE (AIDANT ou FAMILLE)
 * Gère l'activation du compte, la génération de mot de passe (Aidants) 
 * et l'activation du dossier Patient (Familles).
 */
router.post("/validate-member", middleware(['COORDINATEUR']), async (req, res) => {
    const { user_id, role, email, nom } = req.body;

    try {
        let messageExtra = "";
        
        // 1. CAS SPÉCIFIQUE : AIDANT (Génération d'accès)
        if (role === 'AIDANT') {
            const tempPassword = Math.random().toString(36).slice(-10) + "!"; 
            
            // Mise à jour sécurisée du mot de passe dans Supabase Auth (nécessite service_role key)
            const { error: authError } = await supabase.auth.admin.updateUserById(
                user_id, 
                { password: tempPassword }
            );

            if (authError) throw authError;

            messageExtra = `
                <div style="background: #f8fafc; padding: 20px; border-radius: 12px; margin: 20px 0; border: 1px solid #e2e8f0;">
                    <p style="margin: 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: bold;">Vos accès sécurisés</p>
                    <p style="margin: 10px 0 5px 0;">👤 Identifiant : <b>${email}</b></p>
                    <p style="margin: 0;">🔑 Mot de passe : <span style="background: #cbd5e1; padding: 2px 5px; border-radius: 4px; font-family: monospace;">${tempPassword}</span></p>
                </div>
            `;
       
            console.log(`✅ Accès généré pour Aidant: ${email}`);

        }

        // 2. ACTIVATION DU PROFIL UTILISATEUR
        const { error: profileErr } = await supabase
            .from("profiles")
            .update({ statut_validation: 'ACTIF' })
            .eq("id", user_id);

        if (profileErr) throw profileErr;

        // 3. 💥 LOGIQUE DUO PACK : ACTIVATION DU PATIENT ASSOCIÉ (si Famille)
        if (role === 'FAMILLE') {
            const { error: patientErr } = await supabase
                .from("patients")
                .update({ statut_validation: 'ACTIF' })
                .eq("famille_user_id", user_id);

            if (patientErr) {
                console.warn("⚠️ Attention : Profil famille activé mais erreur lors de l'activation du patient lié.");
            } else {
                console.log(`🚀 [DUO PACK] Dossier Patient activé pour la famille ${user_id}`);
            }
        }

        // 4. ENVOI DE L'EMAIL PREMIUM DE BIENVENUE
        const html = `
            <div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <div style="background-color: #0f172a; padding: 30px; text-align: center;">
                    <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 60px;">
                    <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 18px; letter-spacing: 2px; text-transform: uppercase;">Santé Plus Services</h1>
                </div>
                <div style="padding: 40px; line-height: 1.6;">
                    <h2 style="color: #16a34a; margin-top: 0;">Compte Activé !</h2>
                    <p>Bonjour <b>${nom}</b>,</p>
                    <p>Nous avons le plaisir de vous informer que votre accès à la plateforme <b>Santé Plus Services</b> est désormais opérationnel.</p>
                    
                    ${messageExtra}

                    <div style="text-align: center; margin-top: 30px;">
                        <a href="https://votre-frontend-url.com" style="background-color: #16a34a; color: #ffffff; padding: 14px 30px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">Accéder à mon espace</a>
                    </div>
                    
                    <p style="font-size: 13px; color: #64748b; margin-top: 30px;">
                        ${role === 'FAMILLE' ? "Vous pouvez dès à présent suivre le journal de soins de votre proche en temps réel." : "Vous pouvez consulter votre planning et démarrer vos premières visites."}
                    </p>
                </div>
                <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8;">
                    Ceci est un message automatique de sécurité. Ne pas répondre.
                </div>
            </div>`;

        await sendEmailAPI(email, "Activation de votre compte Santé Plus", html);

        res.json({ status: "success" });

    } catch (err) {
        console.error("❌ Erreur critique Validation Admin:", err.message);
        res.status(500).json({ error: "Une erreur interne est survenue lors de la validation." });
    }
});


/**
 * 🔍 LISTER LES INSCRIPTIONS EN ATTENTE
 */
router.get("/pending-registrations", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        // On récupère les profils en attente
        const { data, error } = await supabase
            .from("profiles")
            .select(`
                id, nom, email, role, telephone,
                patients:patients!famille_user_id (id, nom_complet, formule)
            `)
            .eq("statut_validation", "EN_ATTENTE");

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
module.exports = router;
