const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");



/**
 * ✅ VALIDER UN NOUVEAU MEMBRE (VERSION ÉLITE FUSIONNÉE)
 * Gère l'activation, l'activation Duo Pack (Familles) et l'envoi d'email Premium.
 */
router.post("/validate-member", middleware(['COORDINATEUR']), async (req, res) => {
    const { user_id, role, email, nom } = req.body;

    try {
        console.log(`🚀 [ADMIN] Lancement de la séquence d'activation pour : ${email} (${role})`);

        // 1. ACTIVATION DU PROFIL DANS LA BASE DE DONNÉES
        const { error: profileErr } = await supabase
            .from("profiles")
            .update({ statut_validation: 'ACTIF' })
            .eq("id", user_id);

        if (profileErr) throw profileErr;

        // 2. LOGIQUE DUO PACK : ACTIVATION DU PATIENT ASSOCIÉ (si Famille)
        if (role === 'FAMILLE') {
            const { error: patientErr } = await supabase
                .from("patients")
                .update({ statut_validation: 'ACTIF' })
                .eq("famille_user_id", user_id);

            if (patientErr) {
                console.warn("⚠️ [DUO PACK] Profil famille activé mais erreur sur le dossier patient lié.");
            } else {
                console.log(`✅ [DUO PACK] Dossier Patient activé pour la famille ${user_id}`);
            }
        }

        // 3. GÉNÉRATION DE L'EMAIL HTML PREMIUM
        const emailHtml = `
            <div style="background-color: #F8FAFC; padding: 50px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
                <div style="max-width: 600px; margin: auto; background: white; border-radius: 32px; overflow: hidden; box-shadow: 0 40px 100px rgba(0,0,0,0.08); border: 1px solid #F1F5F9;">
                    <div style="background: #0F172A; padding: 40px; text-align: center;">
                        <img src="https://res.cloudinary.com/dglwrrvh3/image/upload/v1774974945/heart-beat_tjb16u.png" style="width: 50px; margin-bottom: 15px;">
                        <h1 style="color: white; margin: 0; font-size: 16px; letter-spacing: 4px; text-transform: uppercase; font-weight: 900;">Santé Plus Services</h1>
                    </div>
                    <div style="padding: 60px 50px; text-align: left;">
                        <h2 style="color: #0F172A; font-size: 24px; margin-top: 0; font-weight: 900;">Compte Activé !</h2>
                        <p style="color: #64748B; line-height: 1.8; font-size: 16px;">Bonjour <b>${nom}</b>,</p>
                        <p style="color: #64748B; line-height: 1.8; font-size: 16px;">Nous avons le plaisir de vous informer que votre accès à la plateforme <b>Santé Plus Services</b> est désormais opérationnel.</p>
                        
                        <p style="color: #64748B; line-height: 1.8; font-size: 15px; margin-top: 20px;">
                            ${role === 'FAMILLE' 
                                ? "Vous pouvez dès à présent suivre le journal de soins de votre proche et consulter les rapports d'intervention en temps réel." 
                                : "Vous pouvez maintenant consulter votre planning d'interventions et démarrer vos premières visites terrain."}
                        </p>

                        <div style="text-align: center; margin-top: 45px;">
                            <a href="https://stevenckohr-pixel.github.io/sante-plus-frontend/" 
                               style="background: #10B981; color: white; padding: 20px 40px; text-decoration: none; border-radius: 18px; font-weight: 800; font-size: 13px; display: inline-block; box-shadow: 0 15px 30px rgba(16, 185, 129, 0.2); text-transform: uppercase; letter-spacing: 1px;">
                                Accéder à mon espace
                            </a>
                        </div>
                    </div>
                    <div style="background: #F8FAFC; padding: 30px; text-align: center; border-top: 1px solid #F1F5F9;">
                        <p style="margin: 0; font-size: 10px; color: #CBD5E1; text-transform: uppercase; font-weight: 700; letter-spacing: 1px;">© 2026 Santé Plus Services • Cotonou, Bénin</p>
                    </div>
                </div>
            </div>
        `;

        // 4. ENVOI SECURISE (Le try/catch ici empêche le crash si Brevo échoue)
        try {
            await sendEmailAPI(email, "Activation de votre compte Santé Plus", emailHtml);
            console.log(`✅ [EMAIL] Mail d'activation envoyé à ${email}`);
        } catch (mailErr) {
            console.error("⚠️ [EMAIL ERROR] Impossible d'envoyer le mail de bienvenue, mais activation réussie :", mailErr.message);
        }

        res.json({ status: "success", message: "Séquence d'activation terminée." });

    } catch (err) {
        console.error("❌ [ADMIN ERROR]:", err.message);
        res.status(500).json({ error: "Une erreur technique a empêché la validation." });
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
