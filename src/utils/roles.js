function isGuest(role) {
  return role === 'Guest';
}

function canEditContent(role) {
  return role === 'Owner' || role === 'Admin' || role === 'Member';
}

function guestEditMessage() {
  return 'Guests can view and comment only';
}

module.exports = {
  isGuest,
  canEditContent,
  guestEditMessage,
};
