export interface PelatologioRecord {
  amount?: number;
  cancellationReason?: string;
  clientServiceType?: 'garage' | 'parkingcarwash' | 'rental';
  comments?: string;
  completionDateTime?: Date | string;
  contactId?: string; // ObjectId as string
  cooperatingVatNumber?: string;
  createdAt?: Date | string;
  customerVatNumber?: string;
  dateTime?: Date | string;
  dclId?: number;
  entityVatNumber?: string;
  entryCompletion?: boolean;
  exitDateTime?: Date | string;
  fim?: {
    fimAA?: number;
    fimIssueDate?: string; // YYYY-MM-DD
    fimIssueTime?: string; // HH:mm:ss
    fimNumber?: string;
  };
  foreignVehicleRegNumber?: string;
  invoiceKind?: 'FIM_RECEIPT' | 'INVOICE' | 'RECEIPT';
  invoiceMark?: string;
  isDiffVehReturnLocation?: boolean;
  nonIssueInvoice?: boolean;
  offSiteProvidedService?: 'MOVE_TO_SAME_ENTITY' | 'TEMPORARY_EXIT';
  otherBranch?: number;
  providedServiceCategory?:
    | 'CATALOG_WORK'
    | 'CUSTOM_AGREEMENT'
    | 'DAMAGE_ASSESSMENT'
    | 'FREE_SERVICE'
    | 'OTHER'
    | 'WARRANTY_COMPENSATION';
  providedServiceCategoryOther?: string;
  reasonNonIssueType?:
    'FREE_SERVICE' | 'GUARANTEE_PROVISION_COMPENSATION' | 'SELF_USE';
  status?: 'active' | 'cancelled' | 'completed' | 'noInvoiceYet';
  updatedAt?: Date | string;
  updatesHistory?: {
    comments?: string;
    dateTime?: Date | string;
    updateInfo?: string;
    userId?: string; // ObjectId as string
  }[];
  vehicleCategory?: string;
  vehicleFactory?: string;
  vehicleId?: string; // ObjectId as string
  vehicleMovementPurpose?:
    'FREE_SERVICE' | 'OTHER' | 'PERSONAL_USE' | 'RENTAL' | 'REPAIR';
  vehicleRegNumber?: string;
  vehicleReturnLocation?: string;
  venueId?: string; // ObjectId as string
}

export interface AadeInvoice {
  authentication_code: string;
  closed: boolean;
  comments: string;
  counterpart: {
    activity: {
      description: 'Activity of the counterpart';
      type: string;
    };
    address: {
      city: {
        description: 'City of the counterpart';
        type: string;
      };
      number: {
        description: 'Street number of the counterpart';
        type: string;
      };
      postal_code: {
        description: 'Postal code of the counterpart';
        type: string;
      };
      street: {
        description: 'Street name of the counterpart';
        type: string;
      };
    };
    branch: {
      description: 'Branch number of the counterpart';
      type: number;
    };
    country: {
      description: 'Country of the counterpart';
      type: string;
    };
    name: {
      description: 'Name of the counterpart';
      type: string;
    };
    phone: {
      description: 'Phone number of the counterpart';
      type: string;
    };
    tax_office: {
      description: 'Tax office of the counterpart';
      type: string;
    };
    vat_number: {
      description: 'VAT number of the counterpart';
      type: string;
    };
  };
  details: {
    name: string;
    net_value: number;
    quantity: number;
    rec_type?: number;
  }[];
  gross_value: number;
  header: {
    code: string;
    serial_number: string;
    series: {
      code: string;
    };
  };
  issue_date: string;
  issuer: {
    activity: string;
    address: {
      city: string;
      number?: string;
      postal_code: string;
      street: string;
    };
    branch?: number;
    name: string;
    phone: string;
    tax_office: string;
    vat_number: string;
  };
  mark: string;
  move_purpose?: {
    code: {
      description: 'Movement code is the reason why goods are transported (1-8).';
      type: string;
    };
  };
  payment_methods: {
    amount: number;
    code: string;
  }[];
  qr: string;
  uid: string;
  url: string;
}
