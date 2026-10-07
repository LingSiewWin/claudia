/// The sink. Captured bonds are paid to this script's address and can never
/// be spent: nobody, the approver included, profits from a rejected request.
validator always_fail {
  else(_) {
    fail
  }
}
