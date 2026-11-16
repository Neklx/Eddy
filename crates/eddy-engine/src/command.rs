/// Control messages sent to the audio thread. Plain data (`Copy`) so they travel
/// through the wait-free ring without allocating.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum Command {
    #[default]
    Nop,
    SetSend { src: u8, dst: u8, gain: f32 },
    SetSourceGain { src: u8, gain: f32 },
    SetSourceMute { src: u8, mute: bool },
    SetDestGain { dst: u8, gain: f32 },
    SetStageEnabled { src: u8, stage: Stage, on: bool },
    SetParam { src: u8, param: Param, value: f32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage { HighPass, Noise, Gate, Eq, Compressor, Leveler }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Param {
    HighPassHz,
    NoiseStrength,
    GateThresholdDb,
    GateReleaseMs,
    CompThresholdDb,
    CompRatio,
    CompMakeupDb,
    LevelerTargetDb,
}

impl Stage {
    pub fn name(self) -> &'static str {
        match self {
            Stage::HighPass => "high_pass", Stage::Noise => "noise", Stage::Gate => "gate",
            Stage::Eq => "eq", Stage::Compressor => "compressor", Stage::Leveler => "leveler",
        }
    }
    pub fn from_name(s: &str) -> Option<Stage> {
        [Stage::HighPass, Stage::Noise, Stage::Gate, Stage::Eq, Stage::Compressor, Stage::Leveler].into_iter().find(|x| x.name() == s)
    }
}

impl Param {
    pub fn name(self) -> &'static str {
        match self {
            Param::HighPassHz => "high_pass_hz", Param::NoiseStrength => "noise_strength",
            Param::GateThresholdDb => "gate_threshold_db", Param::GateReleaseMs => "gate_release_ms",
            Param::CompThresholdDb => "comp_threshold_db", Param::CompRatio => "comp_ratio",
            Param::CompMakeupDb => "comp_makeup_db", Param::LevelerTargetDb => "leveler_target_db",
        }
    }
    pub fn from_name(s: &str) -> Option<Param> {
        use Param::*;
        [HighPassHz, NoiseStrength, GateThresholdDb, GateReleaseMs, CompThresholdDb, CompRatio, CompMakeupDb, LevelerTargetDb].into_iter().find(|x| x.name() == s)
    }
}
