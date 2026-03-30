const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");

/**
 * ✅ VALIDER UN NOUVEAU MEMBRE (AIDANT ou FAMILLE)
 * Seul le Coordinateur peut valider un compte en attente.
 */
router.post("/validate-member", middleware(['COORDINATEUR']), async (req, res) => {
    const { user_id, role, email, nom } = req.body;

    try {
        let messageExtra = "";
        
        // 1. SI C'EST UN AIDANT : On génère un mot de passe et on met à jour Supabase Auth
        if (role === 'AIDANT') {
            const tempPassword = Math.random().toString(36).slice(-10) + "!"; // Mot de passe robuste
            
            // On utilise l'API Admin de Supabase pour forcer le nouveau mot de passe
            const { error: authError } = await supabase.auth.admin.updateUserById(
                user_id, 
                { password: tempPassword }
            );

            if (authError) throw authError;

            messageExtra = `
                <div style="background: #f8fafc; padding: 20px; border-radius: 12px; margin: 20px 0; border: 1px solid #e2e8f0;">
                    <p style="margin: 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: bold;">Vos accès sécurisés</p>
                    <p style="margin: 10px 0 5px 0;">👤 Identifiant : <b>${email}</b></p>
                    <p style="margin: 0;">🔑 Mot de passe : <span style="background: #cbd5e1; padding: 2px 5px; border-radius: 4px;">${tempPassword}</span></p>
                </div>
            `;
        }

        // 2. ACTIVATION DU PROFIL DANS LA TABLE PROFILES
        const { error: profileErr } = await supabase
            .from("profiles")
            .update({ statut_validation: 'ACTIF' })
            .eq("id", user_id);

        if (profileErr) throw profileErr;

        // 3. ENVOI DE L'EMAIL PREMIUM DE BIENVENUE
        const html = `
            <div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
                <div style="background-color: #0f172a; padding: 30px; text-align: center;">
                    <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 60px;">
                    <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 18px; letter-spacing: 2px; text-transform: uppercase;">Santé Plus Services</h1>
                </div>
                <div style="padding: 40px; line-height: 1.6;">
                    <h2 style="color: #16a34a; margin-top: 0;">Compte Activé !</h2>
                    <p>Bonjour <b>${nom}</b>,</p>
                    <p>Nous avons le plaisir de vous informer que votre accès à la plateforme <b>Santé Plus Services</b> a été validé et activé.</p>
                    
                    ${messageExtra}

                    <div style="text-align: center; margin-top: 30px;">
                        <a href="https://votre-app-frontend.github.io" style="background-color: #16a34a; color: #ffffff; padding: 14px 30px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">Accéder au Portail</a>
                    </div>
                </div>
                <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8;">
                    Ceci est un message automatique de sécurité. Ne pas répondre.
                </div>
            </div>`;

        await sendEmailAPI(email, "Activation de votre compte Santé Plus", html);

        res.json({ status: "success" });

    } catch (err) {
        console.error("❌ Erreur Validation Admin:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
