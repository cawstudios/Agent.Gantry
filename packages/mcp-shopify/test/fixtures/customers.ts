export interface MockCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export const KNOWN_CUSTOMER: MockCustomer = {
  id: 'gid://shopify/Customer/1001',
  firstName: 'Aanya',
  lastName: 'Shah',
  email: 'aanya.shah@example.com',
  phone: '+919876543210',
};

export const RECOVERY_CUSTOMER: MockCustomer = {
  id: 'gid://shopify/Customer/1002',
  firstName: 'Rohan',
  lastName: 'Kapoor',
  email: 'rohan.kapoor@example.com',
  phone: '+919800000200',
};

export const BUSY_CUSTOMER: MockCustomer = {
  id: 'gid://shopify/Customer/1003',
  firstName: 'Meera',
  lastName: 'Joshi',
  email: 'meera.joshi@example.com',
  phone: '+919800000300',
};
