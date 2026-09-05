#![allow(clippy::unwrap_used)]

use super::EnvironmentManager;
use super::LOCAL_ENVIRONMENT_ID;

#[tokio::test]
async fn owned_registration_never_replaces_and_removed_handles_stay_dead() {
    let manager = EnvironmentManager::default_for_tests();
    manager
        .register_environment("lease".into(), "ws://127.0.0.1:1".into(), None)
        .unwrap();
    let original = manager.get_environment("lease").unwrap();
    assert!(
        manager
            .register_environment("lease".into(), "ws://127.0.0.1:2".into(), None)
            .is_err()
    );
    assert!(
        manager
            .upsert_environment("lease".into(), "ws://127.0.0.1:2".into(), None)
            .is_err()
    );
    assert!(manager.remove_environment("lease").await.unwrap());
    assert!(!manager.remove_environment("lease").await.unwrap());
    manager
        .register_environment("lease".into(), "ws://127.0.0.1:2".into(), None)
        .unwrap();
    assert!(!std::sync::Arc::ptr_eq(
        &original,
        &manager.get_environment("lease").unwrap()
    ));
    let error = original.force_info().await.unwrap_err();
    assert!(error.to_string().contains("environment was removed"));
    manager.remove_environment("lease").await.unwrap();
}

#[tokio::test]
async fn static_environment_cannot_be_removed() {
    let manager = EnvironmentManager::default_for_tests();
    assert!(
        manager
            .remove_environment(LOCAL_ENVIRONMENT_ID)
            .await
            .is_err()
    );
    assert!(manager.get_environment(LOCAL_ENVIRONMENT_ID).is_some());
    manager
        .upsert_environment("configured".into(), "ws://127.0.0.1:1".into(), None)
        .unwrap();
    assert!(manager.remove_environment("configured").await.is_err());
}
