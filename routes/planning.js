const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

// 1. CRÉER UNE ASSIGNATION (Coordinateur uniquement)
router.post("/add", middleware(["COORDINATEUR"]), async (req, res) => {
  const { patient_id, aidant_id, date_prevue, heure_prevue, notes } = req.body;
  const { error } = await supabase.from("planning").insert([
    {
      patient_id,
      aidant_id,
      date_prevue,
      heure_prevue,
      notes_coordinateur: notes,
    },
  ]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "success" });
});

// 2. LIRE LE PLANNING (Filtré par rôle)
router.get("/", middleware(["COORDINATEUR", "AIDANT"]), async (req, res) => {
  let query = supabase.from("planning").select(`
        *,
        patient:patients(nom_complet, adresse),
        aidant:aidant_id(nom)
    `);

  // Si c'est un aidant, il ne voit que son planning
  if (req.user.role === "AIDANT") {
    query = query
      .eq("aidant_id", req.user.userId)
      .eq("date_prevue", new Date().toISOString().split("T")[0]);
  }

  const { data, error } = await query.order("heure_prevue", {
    ascending: true,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
