const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const jwt = require("jsonwebtoken");

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

module.exports = router;
