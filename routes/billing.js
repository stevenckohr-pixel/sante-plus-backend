const axios = require("axios");
const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

/**
 * 📊 1. LISTER LES ABONNEMENTS
 */
router.get("/", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
  try {
    let query = supabase.from("abonnements").select(`
            *,
            patient:patients (id, nom_complet, formule, famille_user_id)
        `);

    if (req.user.role === "FAMILLE") {
      const { data: patientData } = await supabase
        .from("patients")
        .select("id")
        .eq("famille_user_id", req.user.userId)
        .maybeSingle();

      if (!patientData) return res.json([]);
      query = query.eq("patient_id", patientData.id);
    }

    const { data, error } = await query.order("created_at", { ascending: false });
    
    // Si la table est vide, Supabase ne renvoie pas d'erreur, mais on vérifie quand même
    if (error) {
        console.error("Erreur Abonnements:", error);
        return res.status(500).json({ error: error.message });
    }
    
    res.json(data || []); // On renvoie un tableau vide au lieu de planter
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ 2. ENREGISTRER UN PAIEMENT MANUEL (Espèces)
 */
router.post("/pay", middleware(["COORDINATEUR"]), async (req, res) => {
  const { abonnement_id, montant } = req.body;
  try {
    const { data: abo, error: errAbo } = await supabase
      .from("abonnements")
      .update({
        montant_paye: montant,
        statut: "Payé",
        date_paiement: new Date(),
      })
      .eq("id", abonnement_id)
      .select()
      .single();

    if (errAbo) throw errAbo;

    // Déblocage immédiat de l'accès
    await supabase
      .from("patients")
      .update({ statut_paiement: "A jour" })
      .eq("id", abo.patient_id);
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 💳 3. GÉNÉRER UN LIEN FEDAPAY
 */
router.post("/generate-payment", middleware(["FAMILLE"]), async (req, res) => {
  const { abonnement_id, montant, email_client } = req.body;
  if (!process.env.FEDAPAY_SECRET_KEY)
    return res.status(500).json({ error: "Config FedaPay manquante." });

  try {
    const response = await axios.post(
      "https://api.fedapay.com/v1/transactions",
      {
        description: `Santé Plus - Facture #${abonnement_id.substring(0, 8)}`,
        amount: montant,
        currency: { iso: "XOF" },
        callback_url: "https://stevenckohr-pixel.github.io/sante-plus-frontend/#billing?status=success",
        metadata: { abonnement_id: abonnement_id },
        customer: { email: email_client || "client@santeplus.bj" },
      },
      {
        headers: { Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}` },
      },
    );

    const transaction = response.data.v1
      ? response.data.v1.transaction
      : response.data.transaction;
    res.json({ url: `https://checkout.fedapay.com/${transaction.token}` });
  } catch (err) {
    res.status(500).json({ error: "Lien de paiement impossible." });
  }
});

/**
 * ⚡ 4. WEBHOOK (SANS MIDDLEWARE)
 * Appelée automatiquement par FedaPay après le paiement
 */
router.post("/webhook", async (req, res) => {
  const event = req.body;
  // FedaPay envoie l'événement transaction.approved
  if (event.entity && event.entity.status === "approved") {
    const abonnement_id = event.entity.metadata
      ? event.entity.metadata.abonnement_id
      : null;
    const montant_recu = event.entity.amount;

    if (abonnement_id) {
      console.log(`✅ [WEBHOOK] Validation auto pour : ${abonnement_id}`);
      try {
        const { data: abo } = await supabase
          .from("abonnements")
          .update({
            montant_paye: montant_recu,
            statut: "Payé",
            date_paiement: new Date(),
          })
          .eq("id", abonnement_id)
          .select()
          .single();

        if (abo) {
          await supabase
            .from("patients")
            .update({ statut_paiement: "A jour" })
            .eq("id", abo.patient_id);
        }
      } catch (err) {
        console.error("❌ Erreur Webhook Sync:", err.message);
      }
    }
  }
  res.sendStatus(200);
});

module.exports = router;
