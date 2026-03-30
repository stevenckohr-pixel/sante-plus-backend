const cron = require("node-cron");
const supabase = require("./supabaseClient");

function startCronJobs() {
  // 1. GÉNÉRATION DES FACTURES (Le 1er du mois à 00h01)
  cron.schedule("1 0 1 * *", async () => {
    console.log("🤖 [CRON] Génération des abonnements mensuels...");
    const { data: patients } = await supabase
      .from("patients")
      .select("id, formule");

    const prices = { Basic: 50000, Standard: 75000, Premium: 100000 };
    const monthYear = new Date().toLocaleDateString("fr-FR", {
      month: "2-digit",
      year: "numeric",
    });

    const newBills = patients.map((p) => ({
      patient_id: p.id,
      mois_annee: monthYear,
      montant_du: prices[p.formule] || 50000,
      statut: "En attente",
    }));

    await supabase.from("abonnements").insert(newBills);
  });

  // 2. VÉRIFICATION DES IMPAYÉS (Tous les jours à minuit)
  // Si après le 5 du mois ce n'est toujours pas payé -> "En retard"
  cron.schedule("0 0 * * *", async () => {
    const dayOfMonth = new Date().getDate();
    if (dayOfMonth > 5) {
      await supabase
        .from("abonnements")
        .update({ statut: "En retard" })
        .eq("statut", "En attente");

      // On met aussi à jour la table patients pour le blocage d'accès
      const { data: lateBills } = await supabase
        .from("abonnements")
        .select("patient_id")
        .eq("statut", "En retard");
      const lateIds = lateBills.map((b) => b.patient_id);
      await supabase
        .from("patients")
        .update({ statut_paiement: "En retard" })
        .in("id", lateIds);
    }
  });
}

module.exports = startCronJobs;
