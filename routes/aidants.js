const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

/**
 * 📋 1. LISTER TOUS LES AIDANTS (Coordinateur uniquement)
 */
router.get("/", middleware(["COORDINATEUR"]), async (req, res) => {
  try {
    // On récupère les profils ayant le rôle AIDANT
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("role", "AIDANT")
      .order("nom", { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📈 2. VOIR LES STATS D'ACTIVITÉ D'UN AIDANT
 */
router.get("/stats/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const aidantId = req.params.id;
  try {
    const { data, error } = await supabase
      .from("visites")
      .select("id, statut_validation")
      .eq("aidant_id", aidantId);

    if (error) throw error;

    const total = data.length;
    const valides = data.filter((v) => v.statut_validation === "Validé").length;

    res.json({
      total_visites: total,
      taux_validation: total > 0 ? Math.round((valides / total) * 100) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
