const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const jwt = require("jsonwebtoken");
const middleware = require("../middleware"); 

// Route Inscription avec rôle
router.post("/register", async (req, res) => {
  const { email, password, nom, telephone, role } = req.body;

  const { data: auth, error: authErr } = await supabase.auth.signUp({
    email,
    password,
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const { error: profileErr } = await supabase
    .from("profiles")
    .insert([{ id: auth.user.id, nom, telephone, role }]);

  if (profileErr) return res.status(500).json({ error: profileErr.message });
  res.json({ status: "success" });
});

// 2. CONNEXION
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const { data: authData, error: authErr } =
    await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

  if (authErr) return res.status(401).json({ error: "Identifiants invalides" });

  // Récupérer le rôle dans la table profiles
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, nom")
    .eq("id", authData.user.id)
    .single();

  const token = jwt.sign(
    { userId: authData.user.id, role: profile.role },
    process.env.JWT_SECRET,
    { expiresIn: "24h" },
  );

  res.json({ token, role: profile.role, nom: profile.nom });
});

// Dans backend/routes/auth.js
router.get("/profiles", middleware(["COORDINATEUR"]), async (req, res) => {
  const { role } = req.query;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, nom, email, role")
    .eq("role", role);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * 🔔 ENREGISTRER UN APPAREIL POUR LES NOTIFICATIONS PUSH
 */
router.post("/subscribe-push", middleware(), async (req, res) => {
  const { endpoint, p256dh, auth } = req.body;

  if (!endpoint || !p256dh || !auth) {
    return res
      .status(400)
      .json({ error: "Données de souscription incomplètes" });
  }

  try {
    // .upsert permet de mettre à jour si l'appareil existe déjà, sinon il l'insère
    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: req.user.userId, // Récupéré via ton middleware JWT
        endpoint: endpoint,
        p256dh: p256dh,
        auth: auth,
      },
      { onConflict: "endpoint" },
    );

    if (error) throw error;

    res.status(201).json({
      status: "success",
      message: "Appareil enregistré pour les notifications.",
    });
  } catch (err) {
    console.error("❌ Erreur enregistrement Push:", err.message);
    res.status(500).json({ error: "Impossible d'enregistrer l'appareil." });
  }
});


/**
 * 👤 CRÉATION D'UTILISATEUR PAR UN ADMIN (Aidant ou Coordinateur)
 * Cette route crée le compte Auth + le profil d'un seul coup
 */
router.post("/create-member", middleware(["COORDINATEUR"]), async (req, res) => {
    const { email, password, nom, telephone, role } = req.body;

    try {
        // 1. Création du compte dans l'Authentification Supabase 
        // On utilise l'admin API (nécessite la clé SERVICE_ROLE dans supabaseClient)
        const { data: userData, error: authErr } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true // On valide l'email d'office
        });

        if (authErr) throw authErr;

        // 2. Création du profil dans ta table "profiles"
        const { error: profileErr } = await supabase
            .from("profiles")
            .insert([{
                id: userData.user.id,
                nom,
                telephone,
                email,
                role // 'AIDANT' ou 'COORDINATEUR'
            }]);

        if (profileErr) throw profileErr;

        // 3. Optionnel : Envoyer un mail automatique à l'employé avec ses accès via Brevo
        
        res.json({ status: "success", message: `Compte ${role} créé pour ${nom}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



router.post("/register-family-patient", async (req, res) => {
    const { email, password, nom_famille, tel_famille, nom_patient, adresse_patient, formule } = req.body;

    try {
        // 1. Création du compte Auth Supabase
        const { data: auth, error: authErr } = await supabase.auth.signUp({ email, password });
        if (authErr) throw authErr;

        // 2. Création du profil Famille
        await supabase.from("profiles").insert([{
            id: auth.user.id,
            nom: nom_famille,
            telephone: tel_famille,
            role: 'FAMILLE',
            statut_validation: 'EN_ATTENTE'
        }]);

        // 3. Création du dossier Patient lié
        await supabase.from("patients").insert([{
            nom_complet: nom_patient,
            adresse: adresse_patient,
            formule: formule,
            famille_user_id: auth.user.id,
            statut_validation: 'EN_ATTENTE'
        }]);

        // 4. EMAIL AUTOMATIQUE : "Accusé de réception"
        const { sendEmailAPI } = require("../utils");
        const html = `
            <div style="font-family: sans-serif; color: #1e293b;">
                <h2 style="color: #16a34a;">Demande reçue !</h2>
                <p>Bonjour ${nom_famille},</p>
                <p>Nous avons bien reçu votre demande d'inscription pour le suivi de <b>${nom_patient}</b>.</p>
                <p>Notre équipe de coordination va examiner votre dossier sous 24h. Vous recevrez un mail dès que l'accès sera activé.</p>
            </div>`;
        sendEmailAPI(email, "Inscription enregistrée - Santé Plus", html);

        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



/**
 * 👨‍👩‍👧‍👦 INSCRIPTION DUO : FAMILLE + PATIENT
 * Crée le compte Auth, le profil Famille et le dossier Patient en un clic.
 */
router.post("/register-family-patient", async (req, res) => {
    const { 
        email, password, nom_famille, tel_famille, 
        nom_patient, adresse_patient, formule 
    } = req.body;

    try {
        // 1. Création du compte dans Supabase Auth
        const { data: auth, error: authErr } = await supabase.auth.signUp({
            email,
            password
        });

        if (authErr) throw authErr;
        const userId = auth.user.id;

        // 2. Création du profil 'FAMILLE' dans la table profiles
        const { error: profileErr } = await supabase
            .from("profiles")
            .insert([{
                id: userId,
                nom: nom_famille,
                telephone: tel_famille,
                email: email,
                role: 'FAMILLE',
                statut_validation: 'EN_ATTENTE' // Reste à valider par l'admin
            }]);

        if (profileErr) throw profileErr;

        // 3. Création du dossier 'PATIENT' lié à cette famille
        const { error: patientErr } = await supabase
            .from("patients")
            .insert([{
                nom_complet: nom_patient,
                adresse: adresse_patient,
                formule: formule,
                famille_user_id: userId,
                statut_paiement: 'A jour', // On considère à jour pour le test initial
                statut_validation: 'EN_ATTENTE'
            }]);

        if (patientErr) throw patientErr;

        // 4. ENVOI DE L'EMAIL D'ACCUSÉ DE RÉCEPTION (SaaS Premium)
        const { sendEmailAPI } = require("../utils");
        const emailHtml = `
        <div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
            <div style="background-color: #0f172a; padding: 30px; text-align: center;">
                <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 60px;">
                <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 18px; letter-spacing: 2px; text-transform: uppercase;">Santé Plus Services</h1>
            </div>
            <div style="padding: 40px;">
                <h2 style="color: #16a34a; margin-top: 0;">Demande d'inscription reçue !</h2>
                <p>Bonjour <b>${nom_famille}</b>,</p>
                <p>Nous avons bien reçu votre demande d'accompagnement pour votre proche <b>${nom_patient}</b>.</p>
                <p>Un coordinateur va examiner votre dossier et activer votre accès sous 24h. Vous recevrez un email de confirmation dès que le "Live Care Feed" sera prêt.</p>
                
                <div style="background-color: #f8fafc; padding: 20px; border-radius: 12px; margin: 25px 0;">
                    <p style="margin: 0; color: #64748b; font-size: 11px; text-transform: uppercase;">Résumé de votre demande</p>
                    <p style="margin: 10px 0 5px 0;">👤 Patient : <b>${nom_patient}</b></p>
                    <p style="margin: 0;">📋 Formule choisie : <b>${formule}</b></p>
                </div>
            </div>
            <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8;">
                &copy; 2026 Santé Plus Services - Cotonou, Bénin.
            </div>
        </div>`;

        await sendEmailAPI(email, "Votre demande d'inscription - Santé Plus Services", emailHtml);

        res.json({ status: "success", message: "Demande enregistrée avec succès." });

    } catch (err) {
        console.error("❌ Erreur Inscription Duo:", err.message);
        res.status(500).json({ error: err.message });
    }
});
module.exports = router;
