const { fetchCustomerById } = require("../utils/wcCustomer");

// Server-side gate for the Orders section and its sub-permissions. The frontend hides
// links/buttons when access_orders doesn't include the relevant flag, but that's UX only -
// anyone with a valid token could otherwise call these routes directly. Permission is
// re-fetched from WooCommerce on every request (not read from the JWT) so a revoked access
// takes effect immediately, without waiting for the token to expire.
function requireOrderPermission(requiredValue, deniedMessage) {
  return async (req, res, next) => {
    try {
      const customer = await fetchCustomerById(req.user.id);
      const accessOrders = (customer.meta_data || []).find((m) => m.key === "access_orders");
      const values = Array.isArray(accessOrders?.value) ? accessOrders.value : [];

      if (!values.includes(requiredValue)) {
        return res.status(403).json({ success: false, message: deniedMessage });
      }

      next();
    } catch (error) {
      console.error(`Failed to verify order permission '${requiredValue}':`, error);
      return res.status(500).json({
        success: false,
        message: "Failed to verify order access",
      });
    }
  };
}

module.exports = requireOrderPermission("woocommerce", "You do not have access to the Orders section");
module.exports.requireOrderPermission = requireOrderPermission;
module.exports.checkEditUserDetail = requireOrderPermission(
  "edit_user_detail",
  "You do not have permission to edit billing/shipping details on orders"
);
module.exports.checkEditOrderStatus = requireOrderPermission(
  "edit_order_status",
  "You do not have permission to change order status"
);
module.exports.checkSendToShiprocket = requireOrderPermission(
  "send_to_shiprocket",
  "You do not have permission to send orders to Shiprocket"
);
module.exports.checkSendToTekipost = requireOrderPermission(
  "send_to_tekipost",
  "You do not have permission to send orders to TekiPost"
);
module.exports.checkOrderWeight = requireOrderPermission(
  "order_weight",
  "You do not have permission to view order weight"
);
module.exports.checkOrderNote = requireOrderPermission(
  "order_note",
  "You do not have permission to view or add order notes"
);
module.exports.checkDeleteNote = requireOrderPermission(
  "delete_note",
  "You do not have permission to delete order notes"
);
module.exports.checkViewOrder = requireOrderPermission(
  "view_order",
  "You do not have permission to view this order"
);
