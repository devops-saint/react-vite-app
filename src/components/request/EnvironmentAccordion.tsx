import { Control, FieldErrors, UseFormRegister } from 'react-hook-form';
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography,
  Box,
  IconButton,
  Chip,
  MenuItem,
  TextField,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteIcon from '@mui/icons-material/Delete';
import { CreateRequestSchema } from '@/utils/validation';
import { ResourceSection } from './ResourceSection';
import { EnvironmentName } from '@/types/request.types';

interface EnvironmentAccordionProps {
  environmentIndex: number;
  environmentName?: EnvironmentName;
  availableEnvironments: EnvironmentName[];
  control: Control<CreateRequestSchema>;
  register: UseFormRegister<CreateRequestSchema>;
  errors: FieldErrors<CreateRequestSchema>;
  onDelete: () => void;
  expanded: boolean;
  onToggle: () => void;
}

export function EnvironmentAccordion({
  environmentIndex,
  environmentName,
  availableEnvironments,
  control,
  register,
  errors,
  onDelete,
  expanded,
  onToggle,
}: EnvironmentAccordionProps) {
  const displayName = environmentName || 'Select Environment';
  
  return (
    <Accordion
      expanded={expanded}
      onChange={onToggle}
      sx={{
        mb: 2,
        '&:before': { display: 'none' },
        boxShadow: 2,
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        sx={{
          '& .MuiAccordionSummary-content': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Chip 
            label={displayName} 
            color={environmentName ? "primary" : "default"} 
          />
          <Typography variant="h6">{displayName} Environment</Typography>
        </Box>
        <IconButton
          size="small"
          color="error"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          sx={{ mr: 1 }}
        >
          <DeleteIcon />
        </IconButton>
      </AccordionSummary>
      <AccordionDetails>
        <Box sx={{ p: 2 }}>
          <Box sx={{ mb: 3 }}>
            <TextField
              select
              fullWidth
              label="Environment"
              defaultValue={environmentName || ''}
              {...register(`environments.${environmentIndex}.environment`)}
              error={!!errors?.environments?.[environmentIndex]?.environment}
              helperText={errors?.environments?.[environmentIndex]?.environment?.message}
              SelectProps={{
                displayEmpty: true,
              }}
            >
              <MenuItem value="" disabled>
                Select Environment
              </MenuItem>
              {availableEnvironments.map((env) => (
                <MenuItem key={env} value={env}>
                  {env}
                </MenuItem>
              ))}
            </TextField>
          </Box>

          <Typography variant="subtitle1" gutterBottom fontWeight="bold">
            Resources for {displayName}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Add AWS resources that need access in this environment
          </Typography>

          <ResourceSection
            resourceType="s3Buckets"
            environmentIndex={environmentIndex}
            control={control}
            errors={errors}
          />

          <ResourceSection
            resourceType="secretsManager"
            environmentIndex={environmentIndex}
            control={control}
            errors={errors}
          />

          <ResourceSection
            resourceType="kmsKeys"
            environmentIndex={environmentIndex}
            control={control}
            errors={errors}
          />

          <ResourceSection
            resourceType="lambdaFunctions"
            environmentIndex={environmentIndex}
            control={control}
            errors={errors}
          />
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}
