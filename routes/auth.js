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

    // C. Logique 2FA (Temporairement désactivée pour le développement)
    const isDevMode = true; // 👈 Change en 'false' pour réactiver le 2FA plus tard

    if (userRole === "COORDINATEUR" && !isDevMode) {
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
    // 1. On récupère les données
    const { email, password, nom_famille, tel_famille, nom_patient, adresse_patient, formule } = req.body;
    
    // 2. Nettoyage strict de l'email
    const cleanEmail = (email || "").toLowerCase().trim();

    try {
        // 3. Appel unique à Supabase Auth
        const { data: auth, error: authErr } = await supabase.auth.signUp({ 
            email: cleanEmail, 
            password: password 
        });
        
        if (authErr) throw authErr;

        // 4. Insertion dans profiles
        await supabase.from("profiles").insert([{
            id: auth.user.id, 
            nom: nom_famille, 
            telephone: tel_famille,
            email: cleanEmail, // On utilise l'email propre
            role: 'FAMILLE', 
            statut_validation: 'EN_ATTENTE'
        }]);

        // 5. Insertion dans patients
        await supabase.from("patients").insert([{
            nom_complet: nom_patient, 
            adresse: adresse_patient, 
            formule: formule,
            famille_user_id: auth.user.id, 
            statut_paiement: 'A jour', 
            statut_validation: 'EN_ATTENTE'
        }]);

        const html = `<div style="padding: 20px;"><h2>Demande reçue !</h2><p>Un coordinateur validera votre accès sous 24h.</p></div>`;
        await sendEmailAPI(cleanEmail, "Votre demande d'inscription - Santé Plus", html);

        res.json({ status: "success" });
    } catch (err) { 
        console.error("Erreur Inscription:", err);
        res.status(500).json({ error: err.message }); 
    }
});


// ============================================================
// 6. CRÉATION D'EMPLOYÉ PAR LE COORDINATEUR (Avec envoi d'email)
// ============================================================
router.post("/create-member", middleware(["COORDINATEUR"]), async (req, res) => {
    // Le serveur récupère exactement le mot de passe généré sur l'écran (ex: SPS-5936!)
    const { email, password, nom, telephone, role } = req.body;

    try {
        console.log(`[RH] Création du collaborateur : ${email}`);

        // 1. Création dans Supabase Auth
        const { data: userData, error: authErr } = await supabase.auth.admin.createUser({
            email: email,
            password: password,
            email_confirm: true
        });
        if (authErr) throw authErr;

        // 2. Ajout dans la table Profiles
        const { error: profErr } = await supabase.from("profiles").insert([{
            id: userData.user.id, 
            nom, 
            telephone, 
            email, 
            role, 
            statut_validation: 'ACTIF'
        }]);
        if (profErr) throw profErr;

        // 3. ENVOI DE L'EMAIL À L'AIDANT AVEC SES ACCÈS
        const emailHtml = `
            <div style="background-color: #F8FAFC; padding: 40px; font-family: sans-serif;">
                <div style="max-width: 600px; margin: auto; background: white; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.05);">
                    <div style="background: #0F172A; padding: 30px; text-align: center;">
                        <h1 style="color: white; margin: 0; font-size: 18px; letter-spacing: 2px;">SANTÉ PLUS SERVICES</h1>
                    </div>
                    <div style="padding: 40px;">
                        <h2 style="color: #0F172A; font-size: 22px;">Bienvenue dans l'équipe !</h2>
                        <p style="color: #64748B;">Bonjour <b>${nom}</b>, votre compte ${role} a été créé avec succès.</p>
                        
                        <div style="background: #F1F5F9; border-left: 4px solid #10B981; padding: 20px; border-radius: 12px; margin: 25px 0;">
                            <p style="margin: 0; color: #64748B; font-size: 11px; text-transform: uppercase; font-weight: bold;">Vos identifiants de connexion</p>
                            <p style="margin: 10px 0 5px 0; font-size: 15px;">Email : <b>${email}</b></p>
                            <p style="margin: 0; font-size: 15px;">Mot de passe : <b style="color: #10B981;">${password}</b></p>
                        </div>
                        
                        <a href="https://stevenckohr-pixel.github.io/sante-plus-frontend/" style="display: block; background: #0F172A; color: white; padding: 15px; text-align: center; text-decoration: none; border-radius: 12px; font-weight: bold;">Accéder à mon espace</a>
                    </div>
                </div>
            </div>
        `;

        // Envoi via Brevo (Géré de manière sécurisée pour ne pas faire crasher le serveur)
        try {
            await sendEmailAPI(email, "Vos accès collaborateurs - Santé Plus", emailHtml);
            console.log("✅ Mail RH envoyé avec succès !");
        } catch (mailError) {
            console.warn("⚠️ Le compte est créé mais l'email n'a pas pu être envoyé.");
        }

        res.json({ status: "success" });
    } catch (err) { 
        console.error("❌ Erreur Create Member:", err.message);
        res.status(500).json({ error: err.message }); 
    }
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



/**
 * 📸 Mettre à jour la photo de profil
 */
router.post("/update-photo", middleware(), upload.single('photo'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Aucune photo" });
        
        const fileName = `profiles/${req.user.userId}_${Date.now()}.jpg`;
        await supabase.storage.from("photos").upload(fileName, file.buffer, {
            contentType: 'image/jpeg',
            upsert: true
        });
        
        const { data: urlData } = supabase.storage.from("photos").getPublicUrl(fileName);
        const photo_url = urlData.publicUrl;
        
        await supabase.from("profiles").update({ photo_url }).eq("id", req.user.userId);
        
        res.json({ photo_url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📋 Récupérer le profil utilisateur
 */
router.get("/profile/:userId", middleware(), async (req, res) => {
    const { userId } = req.params;
    
    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();
    
    if (error) return res.status(404).json({ error: "Profil non trouvé" });
    res.json(data);
});

/**
 * ✏️ Mettre à jour le profil
 */
router.put("/update-profile", middleware(), async (req, res) => {
    const { nom, email, telephone } = req.body;
    
    const { error } = await supabase
        .from("profiles")
        .update({ nom, email, telephone })
        .eq("id", req.user.userId);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
});

/**
 * 👨‍⚕️ Mettre à jour les infos aidant
 */
router.put("/update-aidant-info", middleware(["AIDANT"]), async (req, res) => {
    const { competences, disponibilites } = req.body;
    
    const { error } = await supabase
        .from("profiles")
        .update({ competences, disponibilites })
        .eq("id", req.user.userId);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
});

module.exports = router;
