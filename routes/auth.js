const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");

const JWT_SECRET = process.env.JWT_SECRET;

// ============================================================
// 1. CONNEXION SÉCURISÉE (Avec 2FA optionnel pour Coordinateur)
// ============================================================
// 1. CONNEXION SÉCURISÉE (Version Unique)
router.post("/login", async (req, res) => {
  try {
    const email = (req.body.email || req.body.u || "").toLowerCase().trim();
    const password = req.body.password || req.body.p;

    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    // A. Authentification Supabase
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (authErr) return res.status(401).json({ error: "Identifiants invalides" });

    // B. Récupération du Profil
    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", authData.user.id)
      .single();

    if (profErr || !profile) {
      console.error("ERREUR LECTURE PROFIL SUPABASE :", profErr);
      return res.status(404).json({ error: "Détails du profil introuvables. Contactez l'admin." });
    }

    // C. Vérification du statut
    if (profile.statut_validation === 'EN_ATTENTE') {
      return res.status(403).json({ error: "Votre compte est en attente de validation." });
    }

    const userRole = (profile.role || "AIDANT").toUpperCase();

    // D. Logique 2FA pour les Coordinateurs uniquement
    if (userRole === "COORDINATEUR") {
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 10 * 60000).toISOString();

      await supabase.from("profiles").update({ reset_code: otpCode, reset_expires: expires }).eq("id", authData.user.id);

      const emailHtml = `
      <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px;">
          <div style="background-color: #0f172a; padding: 20px; text-align: center;">
              <h2 style="color: #ffffff; margin: 0;">SÉCURITÉ SANTÉ PLUS</h2>
          </div>
          <div style="padding: 30px; text-align: center;">
              <h2>Code de vérification</h2>
              <p>Bonjour <b>${profile.nom}</b>, voici votre code sécurisé :</p>
              <div style="background: #f1f5f9; padding: 20px; margin: 25px 0; font-size: 32px; font-weight: 900; letter-spacing: 10px; color: #16a34a; border-radius: 12px;">
                  ${otpCode}
              </div>
          </div>
      </div>`;      
      await sendEmailAPI(email, "Code de sécurité Santé Plus", emailHtml);
      
      return res.json({ status: "require_2fa", email: email });
    }

    // E. Connexion directe pour les autres rôles
    const token = jwt.sign({ userId: authData.user.id, role: userRole }, JWT_SECRET, { expiresIn: "24h" });
    return res.json({ status: "success", token, role: userRole, nom: profile.nom });

  } catch (err) {
    console.error("Login Crash:", err.message);
    res.status(500).json({ error: "Erreur technique serveur" });
  }
});



// ============================================================
// 2. VÉRIFICATION DU CODE 2FA
// ============================================================
router.post("/verify-2fa", async (req, res) => {
  try {
    const email = String(req.body.u || req.body.email || "").toLowerCase().trim();
    const codeSaisi = String(req.body.code || "").trim();

    const { data: profile } = await supabase
        .from("profiles")
        .select("id, reset_code, reset_expires, role, nom")
        .eq("email", email) 
        .single();

    if (!profile) return res.status(401).json({ status: "error", message: "Session expirée." });

    const codeEnBase = profile.reset_code ? String(profile.reset_code).trim() : null;
    
    if (!codeEnBase || codeSaisi !== codeEnBase) {
      return res.status(401).json({ status: "error", message: "Code de sécurité incorrect." });
    }

    const maintenantMS = Date.now();
    const expirationMS = new Date(profile.reset_expires).getTime();
    
    if (maintenantMS > (expirationMS + 300000)) { 
      return res.status(401).json({ status: "error", message: "Ce code a expiré." });
    }

    await supabase.from("profiles").update({ reset_code: null, reset_expires: null }).eq("id", profile.id);

    const token = jwt.sign({ userId: profile.id, role: profile.role }, JWT_SECRET, { expiresIn: "24h" });

    return res.json({ status: "success", token, role: profile.role, nom: profile.nom });

  } catch (err) {
    res.status(500).json({ status: "error", message: "Erreur technique serveur." });
  }
});

// ============================================================
// 3. MOT DE PASSE OUBLIÉ (Demander un code)
// ============================================================
router.all("/request-password-reset", async (req, res) => {
    const email = req.body.email ? req.body.email.toLowerCase().trim() : "";
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60000).toISOString(); // Expire dans 15 min
  
    // On met à jour le code dans la table "profiles"
    const { data: profile, error } = await supabase
      .from("profiles")
      .update({ reset_code: code, reset_expires: expires })
      .eq("email", email)
      .select("nom")
      .maybeSingle();
  
    if (profile) {
      const html = `
        <div style="font-family: sans-serif; color: #1e293b; padding: 20px;">
            <h2>Réinitialisation de mot de passe</h2>
            <p>Bonjour <b>${profile.nom}</b>,</p>
            <p>Voici votre code de vérification pour changer votre mot de passe :</p>
            <div style="background: #f1f5f9; padding: 15px; font-size: 24px; font-weight: 900; letter-spacing: 5px; color: #2563eb; text-align: center; border-radius: 10px;">
                ${code}
            </div>
            <p style="font-size: 12px; color: #64748b;">Ce code expirera dans 15 minutes.</p>
        </div>`;
  
      await sendEmailAPI(email, "Réinitialisation - Santé Plus", html);
    }
  
    // On répond succès même si l'email n'existe pas (Sécurité anti-scan)
    return res.json({ status: "success", message: "Procédure lancée." });
});

// ============================================================
// 4. MOT DE PASSE OUBLIÉ (Changer le mot de passe)
// ============================================================
router.all("/reset-password", async (req, res) => {
    const { email, code, newPassword } = req.body;
    const cleanEmail = (email || "").toLowerCase().trim();
  
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", cleanEmail)
      .eq("reset_code", code)
      .gt("reset_expires", new Date().toISOString())
      .maybeSingle();
  
    if (!profile) return res.status(400).json({ error: "Code invalide ou expiré." });
  
    // Modification du mot de passe dans Supabase Auth (Nécessite Service Role Key)
    const { error: updateAuthErr } = await supabase.auth.admin.updateUserById(
        profile.id, 
        { password: newPassword }
    );

    if (updateAuthErr) return res.status(500).json({ error: "Erreur lors du changement de mot de passe." });

    // Nettoyage du code
    await supabase.from("profiles").update({ reset_code: null, reset_expires: null }).eq("id", profile.id);
  
    return res.json({ status: "success" });
});

// ============================================================
// 5. INSCRIPTION DUO : FAMILLE + PATIENT (Public)
// ============================================================
router.post("/register-family-patient", async (req, res) => {
    const { email, password, nom_famille, tel_famille, nom_patient, adresse_patient, formule } = req.body;

    try {
        const { data: auth, error: authErr } = await supabase.auth.signUp({ email, password });
        if (authErr) throw authErr;

        await supabase.from("profiles").insert([{
            id: auth.user.id, nom: nom_famille, telephone: tel_famille,
            email: email, role: 'FAMILLE', statut_validation: 'EN_ATTENTE'
        }]);

        await supabase.from("patients").insert([{
            nom_complet: nom_patient, adresse: adresse_patient, formule: formule,
            famille_user_id: auth.user.id, statut_paiement: 'A jour', statut_validation: 'EN_ATTENTE'
        }]);

        const html = `<div style="padding: 20px;"><h2>Demande reçue !</h2><p>Un coordinateur validera votre accès sous 24h.</p></div>`;
        await sendEmailAPI(email, "Votre demande d'inscription - Santé Plus", html);

        res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 6. CRÉATION D'EMPLOYÉ PAR LE COORDINATEUR
// ============================================================
router.post("/create-member", middleware(["COORDINATEUR"]), async (req, res) => {
    const { email, password, nom, telephone, role } = req.body;

    try {
        const { data: userData, error: authErr } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (authErr) throw authErr;

        await supabase.from("profiles").insert([{
            id: userData.user.id, nom, telephone, email, role, statut_validation: 'ACTIF'
        }]);

        res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 7. ENREGISTRER UN APPAREIL POUR LES NOTIFICATIONS PUSH
// ============================================================
router.post("/subscribe-push", middleware(), async (req, res) => {
  const { endpoint, p256dh, auth } = req.body;
  if (!endpoint) return res.status(400).json({ error: "Endpoint manquant" });

  try {
    await supabase.from("push_subscriptions").upsert({
        user_id: req.user.userId, endpoint, p256dh, auth
    }, { onConflict: "endpoint" });

    res.status(201).json({ status: "success" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 8. LISTER LES PROFILS (Pour assignation Familles/Aidants)
// ============================================================
router.get("/profiles", middleware(["COORDINATEUR"]), async (req, res) => {
  const { role } = req.query;
  const { data, error } = await supabase.from("profiles").select("id, nom, email, role").eq("role", role);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
