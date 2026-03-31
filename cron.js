const cron = require("node-cron");
const supabase = require("./supabaseClient");
const { sendPushNotification } = require("./utils");

function startCronJobs() {
  /**
   * 1. GÉNÉRATION DES FACTURES (Le 1er du mois à 00h01)
   * On parcourt les dossiers actifs et on génère l'abonnement du mois.
   */
  cron.schedule("1 0 1 * *", async () => {
    console.log("🤖 [FINANCE] Génération des factures mensuelles...");

    // On ne facture que les patients validés (ACTIF)
    const { data: patients, error } = await supabase
      .from("patients")
      .select("id, nom_complet, famille_user_id, montant_prevu, type_pack")
      .eq("statut_validation", "ACTIF");

    if (error || !patients) return console.error("❌ Erreur lecture patients pour facturation");

    const monthYear = new Date().toLocaleDateString("fr-FR", {
      month: "2-digit",
      year: "numeric",
    });

    for (const p of patients) {
      const montant = parseInt(p.montant_prevu) || 0;
      if (montant === 0) continue; // Pas de facture si montant non défini

      // Création de la ligne d'abonnement
      const { data: newBill } = await supabase.from("abonnements").insert([{
        patient_id: p.id,
        mois_annee: monthYear,
        montant_du: montant,
        statut: "En attente",
      }]).select().single();

      // 🔔 NOTIFICATION : On prévient la famille par Push
      if (p.famille_user_id) {
        sendPushNotification(
          p.famille_user_id,
          "💳 Facture disponible",
          `L'abonnement de ${p.nom_complet} pour ${monthYear} (${montant} CFA) est prêt.`,
          "/#billing"
        );
      }
    }
    console.log(`✅ ${patients.length} factures générées pour ${monthYear}`);
  });

  /**
   * 2. VÉRIFICATION DES IMPAYÉS & BLOCAGE (Tous les jours à 04h00)
   * Si après le 5 du mois ce n'est toujours pas payé -> "En retard" + Blocage accès.
   */
  cron.schedule("0 4 * * *", async () => {
    const dayOfMonth = new Date().getDate();
    
    // 🛡️ LOGIQUE DE RECOUVREMENT AUTOMATIQUE
    if (dayOfMonth > 5) {
      console.log("🕵️ [FINANCE] Vérification des retards de paiement...");

      // On récupère les factures en attente (du mois en cours ou passés)
      const { data: pendingBills } = await supabase
        .from("abonnements")
        .select("id, patient_id, patient:patients(nom_complet, famille_user_id)")
        .eq("statut", "En attente");

      if (pendingBills && pendingBills.length > 0) {
        for (const bill of pendingBills) {
          // 1. Marquer la facture en retard
          await supabase.from("abonnements").update({ statut: "En retard" }).eq("id", bill.id);

          // 2. Bloquer l'accès au patient (Statut paiement = En retard)
          await supabase.from("patients").update({ statut_paiement: "En retard" }).eq("id", bill.patient_id);

          // 3. 🔔 Alerte Push sévère à la famille
          if (bill.patient && bill.patient.famille_user_id) {
            sendPushNotification(
              bill.patient.famille_user_id,
              "⚠️ Accès Suspendu",
              `Le suivi de ${bill.patient.nom_complet} est bloqué pour défaut de paiement.`,
              "/#billing"
            );
          }
        }
        console.log(`🚫 ${pendingBills.length} dossiers suspendus pour impayés.`);
      }
    }

    // 💡 RELANCE AMICALE LE 3 DU MOIS
    if (dayOfMonth === 3) {
        const { data: reminderBills } = await supabase
            .from("abonnements")
            .select("patient:patients(famille_user_id, nom_complet)")
            .eq("statut", "En attente");

        if (reminderBills) {
            reminderBills.forEach(b => {
                if(b.patient?.famille_user_id) {
                    sendPushNotification(
                        b.patient.famille_user_id,
                        "⏳ Rappel Paiement",
                        `N'oubliez pas de régulariser l'abonnement de ${b.patient.nom_complet} avant le 5 du mois.`,
                        "/#billing"
                    );
                }
            });
        }
    }
  });
}

module.exports = startCronJobs;
