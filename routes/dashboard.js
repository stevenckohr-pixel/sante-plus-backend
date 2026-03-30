const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

router.get("/stats", middleware(["COORDINATEUR"]), async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    // 1. On lance toutes les requêtes en parallèle pour aller plus vite
    const [patients, visitesToday, visitesPending, impayes] = await Promise.all(
      [
        // Nombre de patients totaux
        supabase.from("patients").select("*", { count: "exact", head: true }),

        // Visites effectuées AUJOURD'HUI
        supabase
          .from("visites")
          .select("*", { count: "exact", head: true })
          .gte("heure_debut", `${today}T00:00:00`),

        // Visites qui attendent d'être validées
        supabase
          .from("visites")
          .select("*", { count: "exact", head: true })
          .eq("statut_validation", "En attente"),

        // Abonnements en retard (Late payments)
        supabase
          .from("abonnements")
          .select("*", { count: "exact", head: true })
          .eq("statut", "En retard"),
      ],
    );

    res.json({
      total_patients: patients.count || 0,
      visits_today: visitesToday.count || 0,
      pending_validation: visitesPending.count || 0,
      late_payments: impayes.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
