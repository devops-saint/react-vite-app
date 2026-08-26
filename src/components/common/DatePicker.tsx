import { TextField, TextFieldProps } from '@mui/material';

export interface DatePickerProps extends Omit<TextFieldProps, 'type' | 'onChange'> {
  value: string;
  onChange: (value: string) => void;
}

export function DatePicker({ value, onChange, ...props }: DatePickerProps) {
  return (
    <TextField
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      InputLabelProps={{ shrink: true }}
      {...props}
    />
  );
}
