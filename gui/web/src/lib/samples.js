/* Demo rule modules embedded for one-click loading. */

export const SAMPLES = {
  basic: `# Clinical Event Logic Rule: Acute High Glucose Detection
rule HighGlucoseAlert:
    intent: "Detect severe acute hyperglycemia in adult inpatients"
    site: ICU
    terminology: LOINC("2339-0")
    source: EHR -> FHIR_R4

    bind glucose_data = Labs.glucose

    let threshold := 180
    let severe_threshold = 250

    when glucose_data.latest > threshold:
    then:
        alert: "High Blood Glucose Detected", "WARNING"
    otherwise:
        suppress: within 4 hours
end`,
  temporal: `# Clinical Rule: Sustained Tachycardia across temporal window
rule SustainedTachycardiaRule:
    intent: "Detect sustained heart rate elevation over consecutive readings"
    schedule: "every 5m"
    site: Cardiology

    bind hr_readings = Vitals.heart_rate where status == "final" within 30 minutes

    let max_hr := 120

    when hr_readings.latest >= max_hr within 15 minutes:
    then:
        alert: "Sustained Tachycardia Observed", hr_readings.latest
        suppress: within 1 hours
end`,
  sepsis: `# Multi-level Sepsis and Shock Alert Rule
rule SepsisEarlyWarningRule:
    intent: "Evaluate multi-parameter vital signs for early sepsis deterioration"
    site: EmergencyDepartment
    terminology: SNOMED("91302008")

    bind sbp = Vitals.systolic_bp
    bind temp = Vitals.body_temperature
    bind wbc = Labs.white_blood_count

    let sbp_crit := 90
    let temp_high := 38.3
    let temp_low := 36.0

    when (sbp.latest < sbp_crit) and ((temp.latest > temp_high) or (temp.latest < temp_low)):
    then:
        alert: "Potential Septic Shock Risk", "CRITICAL", sbp.latest
        suppress: within 6 hours
    otherwise:
        let observation_status := "monitoring"
end`,
  broken: `# Intentionally broken: lexical + syntax errors
rule BrokenRule:
    intent: "This rule fails to compile"
    site: ICU
    let value := 12x
    let text := "unterminated
    when value >:
    then:
        alert "missing colon"
end`,
};

export const SAMPLE_LABELS = {
  basic: 'Basic Rule — High Glucose Alert',
  temporal: 'Temporal Rule — Repeat Lab Logic',
  sepsis: 'Sepsis Bundle — Multi-Lab Alert',
  broken: 'Broken Rule — Error Demo',
};
