export interface PelatologioRecord {
  amount?: number;
  cancellationReason?: string;
  clientServiceType?: 'rental' | 'garage' | 'parkingcarwash';
  comments?: string;
  completionDateTime?: Date | string;
  contactId?: string; // ObjectId as string
  cooperatingVatNumber?: string;
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
  invoiceKind?: 'RECEIPT' | 'INVOICE' | 'FIM_RECEIPT';
  invoiceMark?: string;
  isDiffVehReturnLocation?: boolean;
  nonIssueInvoice?: boolean;
  offSiteProvidedService?: 'TEMPORARY_EXIT' | 'MOVE_TO_SAME_ENTITY';
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
    | 'FREE_SERVICE'
    | 'GUARANTEE_PROVISION_COMPENSATION'
    | 'SELF_USE';
  status?: 'active' | 'completed' | 'cancelled' | 'noInvoiceYet';
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
    | 'RENTAL'
    | 'REPAIR'
    | 'PERSONAL_USE'
    | 'FREE_SERVICE'
    | 'OTHER';
  vehicleRegNumber?: string;
  vehicleReturnLocation?: string;
  venueId?: string; // ObjectId as string
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface AadeInvoice {
  issuer: {
    name: string;
    activity: string;
    address: {
      street: string;
      city: string;
      postal_code: string;
    };
    vat_number: string;
    tax_office: string;
    phone: string;
  };
  closed: boolean;
  counterpart: {
    activity: {
      description: 'Activity of the counterpart';
      type: String;
    };
    address: {
      city: {
        description: 'City of the counterpart';
        type: String;
      };
      number: {
        description: 'Street number of the counterpart';
        type: String;
      };
      postal_code: {
        description: 'Postal code of the counterpart';
        type: String;
      };
      street: {
        description: 'Street name of the counterpart';
        type: String;
      };
    };
    branch: {
      description: 'Branch number of the counterpart';
      type: Number;
    };
    country: {
      description: 'Country of the counterpart';
      type: String;
    };
    name: {
      description: 'Name of the counterpart';
      type: String;
    };
    phone: {
      description: 'Phone number of the counterpart';
      type: String;
    };
    tax_office: {
      description: 'Tax office of the counterpart';
      type: String;
    };
    vat_number: {
      description: 'VAT number of the counterpart';
      type: String;
    };
  };
  gross_value: number;
  issue_date: string;
  header: {
    series: {
      code: string;
    };
    serial_number: string;
    code: string;
  };
  details: {
    name: string;
    quantity: number;
    net_value: number;
  }[];
  payment_methods: {
    code: string;
    amount: number;
  }[];
  mark: string;
  url: string;
  uid: string;
  authentication_code: string;
  qr: string;
}
