const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const jwt = require("jsonwebtoken");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");

/**
 * 🔑 1. CONNEXION (LOGIN)
 * Vérifie les identifiants, le profil et le statut de validation.
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // A. Authentification Supabase
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (authErr) return res.status(401).json({ error: "Identifiants invalides" });

    // B. Récupération du profil et des droits
    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select("id, role, nom, statut_validation")
      .eq("id", authData.user.id)
      .single();

    if (profErr || !profile) {
      return res.status(404).json({ error: "Profil introuvable. Contactez l'administrateur." });
    }

    // C. Vérification du verrou de validation
    if (profile.statut_validation === 'EN_ATTENTE') {
        return res.status(403).json({ 
            error: "Votre compte est en attente de validation. Vous recevrez un email dès qu'il sera actif." 
        });
    }

    // D. Génération du Token JWT sécurisé
    const token = jwt.sign(
      { userId: authData.user.id, role: profile.role },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    // E. Réponse au client
    res.json({ 
        token, 
        role: profile.role, 
        nom: profile.nom,
        id: profile.id
    });

  } catch (err) {
      console.error("Login Error:", err.message);
      res.status(500).json({ error: "Erreur technique lors de la connexion" });
  }
});

/**
 * 👨‍👩‍👧‍👦 2. INSCRIPTION DUO (FAMILLE + PATIENT)
 * Auto-inscription pour la Diaspora. Crée tout en une fois.
 */
router.post("/register-family-patient", async (req, res) => {
    const { 
        email, password, nom_famille, tel_famille, 
        nom_patient, adresse_patient, formule 
    } = req.body;

    try {
        // A. Création du compte Auth
        const { data: auth, error: authErr } = await supabase.auth.signUp({ email, password });
        if (authErr) throw authErr;

        const userId = auth.user.id;

        // B. Création du profil Famille
        await supabase.from("profiles").insert([{
            id: userId,
            nom: nom_famille,
            telephone: tel_famille,
            email: email,
            role: 'FAMILLE',
            statut_validation: 'EN_ATTENTE'
        }]);

        // C. Création du dossier Patient
        await supabase.from("patients").insert([{
            nom_complet: nom_patient,
            adresse: adresse_patient,
            formule: formule,
            famille_user_id: userId,
            statut_validation: 'EN_ATTENTE'
        }]);

        // D. Email d'accusé de réception Premium
        const emailHtml = `
        <div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
            <div style="background-color: #0f172a; padding: 30px; text-align: center;">
                <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 60px;">
                <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 18px; text-transform: uppercase;">Santé Plus Services</h1>
            </div>
            <div style="padding: 40px;">
                <h2 style="color: #16a34a;">Demande d'inscription reçue !</h2>
                <p>Bonjour <b>${nom_famille}</b>,</p>
                <p>Nous avons bien reçu votre demande d'accompagnement pour <b>${nom_patient}</b>.</p>
                <p>Un coordinateur va examiner votre dossier et activer votre accès sous 24h. Vous recevrez un email de confirmation dès que le journal de soins sera prêt.</p>
            </div>
        </div>`;

        sendEmailAPI(email, "Votre demande d'inscription - Santé Plus", emailHtml);

        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 👤 3. CRÉATION DE MEMBRE (ADMIN API)
 * Permet au coordinateur de créer un Aidant sans qu'il ait besoin de s'inscrire.
 */
router.post("/create-member", middleware(["COORDINATEUR"]), async (req, res) => {
    const { email, password, nom, telephone, role } = req.body;

    try {
        const { data: userData, error: authErr } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });

        if (authErr) throw authErr;

        await supabase.from("profiles").insert([{
            id: userData.user.id,
            nom,
            telephone,
            email,
            role,
            statut_validation: 'EN_ATTENTE' // Doit être validé par l'admin ensuite
        }]);

        res.json({ status: "success", message: `Compte ${role} créé.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📋 4. LISTER LES PROFILS PAR RÔLE
 */
router.get("/profiles", middleware(["COORDINATEUR"]), async (req, res) => {
  const { role } = req.query;
  try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, nom, email, role, telephone, created_at")
        .eq("role", role);
      if (error) throw error;
      res.json(data);
  } catch (err) {
      res.status(500).json({ error: err.message });
  }
});

/**
 * 🔔 5. ENREGISTRER UN TERMINAL PUSH
 */
router.post("/subscribe-push", middleware(), async (req, res) => {
  const { endpoint, p256dh, auth } = req.body;
  try {
    await supabase.from("push_subscriptions").upsert(
      {
        user_id: req.user.userId,
        endpoint: endpoint,
        p256dh: p256dh,
        auth: auth,
      },
      { onConflict: "endpoint" }
    );
    res.status(201).json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
