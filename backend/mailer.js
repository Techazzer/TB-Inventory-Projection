const nodemailer = require("nodemailer");
require("dotenv").config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "465"),
  secure: process.env.SMTP_PORT === "465",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendUrgentEmail(to, cc, urgentList) {
  if (!to) throw new Error("No 'To' email address configured.");
  if (!urgentList || urgentList.length === 0) return { message: "No urgent SKUs, skipping email." };

  let tableRows = urgentList.map(item => `
    <tr>
      <td style="border: 1px solid #ddd; padding: 8px;">${item.sku}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${item.stock}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${item.eff_rate}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${item.days_out}</td>
      <td style="border: 1px solid #ddd; padding: 8px; font-weight: bold; color: #dc2626;">${item.reorder_qty}</td>
    </tr>
  `).join("");

  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
      <h2 style="color: #dc2626;">🚨 Urgent Inventory Projection Alert</h2>
      <p>The following <b>${urgentList.length}</b> SKUs have less than 15 days of inventory remaining based on recent consumption rates.</p>
      
      <table style="border-collapse: collapse; width: 100%; max-width: 800px; margin-top: 20px;">
        <thead>
          <tr style="background-color: #f3f4f6;">
            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">SKU</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Current Stock</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Consumption (Eff Rate)</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Days Out</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Suggested Reorder</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
      <br />
      <p>Please initiate reprint/restocking immediately to prevent stockouts.</p>
      <p style="font-size: 12px; color: #888;">Automated message from Reprint Projection System</p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Reprint Alerts" <${process.env.SMTP_USER}>`,
    to,
    cc,
    subject: `🚨 Action Required: ${urgentList.length} Urgent SKUs to Reprint`,
    html,
  });

  return info;
}

module.exports = { sendUrgentEmail };
