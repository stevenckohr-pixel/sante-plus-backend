const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

// 1. CRÉER UNE COMMANDE (Famille ou Coordinateur)
router.post(
  "/add",
  middleware(["FAMILLE", "COORDINATEUR"]),
  async (req, res) => {
    const { patient_id, liste_medocs } = req.body;
    const { error } = await supabase.from("commandes_meds").insert([
      {
        patient_id,
        demandeur_id: req.user.userId,
        liste_medocs,
        statut: "En attente",
      },
    ]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
  },
);

// 2. ASSIGNER ET VALIDER PRIX (Coordinateur uniquement)
router.post("/confirm", middleware(["COORDINATEUR"]), async (req, res) => {
  const { commande_id, aidant_id, prix_total } = req.body;
  const { error } = await supabase
    .from("commandes_meds")
    .update({
      aidant_id,
      prix_total,
      statut: "Confirmée",
    })
    .eq("id", commande_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "success" });
});

// 3. FINALISER LA LIVRAISON (Aidant avec Photo)
router.post("/deliver", middleware(["AIDANT"]), async (req, res) => {
  const { commande_id, photo_url } = req.body;
  const { error } = await supabase
    .from("commandes_meds")
    .update({
      photo_livraison: photo_url,
      statut: "Livrée",
    })
    .eq("id", commande_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "success" });
});

// 4. LISTER LES COMMANDES (Filtré par rôle)
router.get(
  "/",
  middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
  async (req, res) => {
    let query = supabase.from("commandes_meds").select(`
        *,
        patient:patients(nom_complet, adresse),
        demandeur:demandeur_id(nom),
        aidant:aidant_id(nom)
    `);

    if (req.user.role === "AIDANT")
      query = query.eq("aidant_id", req.user.userId);
    if (req.user.role === "FAMILLE") {
      const { data: patient } = await supabase
        .from("patients")
        .select("id")
        .eq("famille_user_id", req.user.userId)
        .single();
      if (patient) query = query.eq("patient_id", patient.id);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });
    res.json(data);
  },
);

module.exports = router;
